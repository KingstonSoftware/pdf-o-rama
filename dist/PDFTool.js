"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PDFTool = void 0;

var _minimist = _interopRequireDefault(require("minimist"));

var _version = require("./version");

var _fsExtra = _interopRequireDefault(require("fs-extra"));

var _tmpPromise = _interopRequireDefault(require("tmp-promise"));

var _hummus = _interopRequireDefault(require("@kingstonsoftware/hummus"));

var _json = _interopRequireDefault(require("json5"));

var _qrcode = _interopRequireDefault(require("qrcode"));

var _md = _interopRequireDefault(require("md5"));

var _autobindDecorator = _interopRequireDefault(require("autobind-decorator"));

var _assert = _interopRequireDefault(require("assert"));

var _class;

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

let PDFTool = (0, _autobindDecorator.default)(_class = class PDFTool {
  constructor(toolName, log, container) {
    container = container || {};
    this.toolName = toolName;
    this.log = log;
    this.hummus = container.hummus || _hummus.default;
    this.fs = container.fs || _fsExtra.default;
  }

  async concat(options) {
    (0, _assert.default)(options.pdfFiles.length !== 0, "Must specify at least one PDF file");
    (0, _assert.default)(options.outputFile, "No output file specified");

    if (options.pdfFiles.length >= 2) {
      for (let pdfFile of options.pdfFiles) {
        if (!this.fs.existsSync(pdfFile)) {
          throw new Error(`File '${pdfFile}' does not exist`);
        }
      }

      const pdfWriter = this.hummus.createWriter(options.outputFile);

      for (let pdfFile of options.pdfFiles) {
        pdfWriter.appendPDFPagesFromPDF(pdfFile);
      }

      pdfWriter.end();
    } else {
      await this.fs.copyFile(options.pdfFiles[0], options.outputFile);
    }
  }

  parsePageTree(context, dict) {
    const dictType = dict.queryObject("Type").value;

    if (dictType === "Pages") {
      // Parse the kids of this tree
      const kids = dict.queryObject("Kids").toJSArray();
      kids.forEach(kid => {
        this.parsePageTree(context, this.pdfReader.parseNewObject(kid.getObjectID()));
      });
    } else if (dictType === "Page") {
      // Parse any field annotations on the page
      let annots = dict.exists("Annots") ? dict.queryObject("Annots") : null;

      if (annots) {
        if (annots.getType() === this.hummus.ePDFObjectIndirectObjectReference) {
          annots = this.pdfReader.parseNewObject(annots.getObjectID());
        }

        annots = annots.toJSArray();
        annots.forEach(annot => {
          let annotDict = null;

          if (annot.getType() === this.hummus.ePDFObjectIndirectObjectReference) {
            annotDict = this.pdfReader.parseNewObject(annot.getObjectID());
          } else {
            annotDict = annot;
          }

          const subType = annotDict.queryObject("Subtype").value;
          const hasName = annotDict.exists("T");
          const hasKids = annotDict.exists("Kids");

          if (subType === "Widget" && !hasKids && hasName) {
            let rect = annotDict.queryObject("Rect").toJSArray().map(n => n.value); // We want the rect in lower left, top right order

            if (rect[1] > rect[3]) {
              rect = [rect[2], rect[3], rect[0], rect[1]];

              if (rect[0] > rect[2]) {
                rect = [rect[2], rect[1], rect[0], rect[3]];
              }
            }

            context.fields.push({
              name: annotDict.queryObject("T").value,
              page: context.nextPageNum,
              rect
            });
          }
        });
        context.nextPageNum += 1;
      }
    }
  }

  async fields(options) {
    (0, _assert.default)(options.pdfFile, "Must specify a PDF from which to extract information");
    (0, _assert.default)(this.fs.existsSync(options.pdfFile), `File '${options.pdfFile}' does not exist`);
    (0, _assert.default)(options.dataFile, `No output data file specified`);
    this.pdfReader = this.hummus.createReader(options.pdfFile);
    const catalogDict = this.pdfReader.queryDictionaryObject(this.pdfReader.getTrailer(), "Root");
    const pagesDict = this.pdfReader.parseNewObject(catalogDict.queryObject("Pages").getObjectID());
    let fieldData = {
      numPages: pagesDict.queryObject("Count").value
    };

    if (catalogDict.exists("AcroForm")) {
      const context = {
        nextPageNum: 0,
        fields: []
      };
      this.parsePageTree(context, pagesDict);
      fieldData.fields = context.fields;

      if (options.outputFile) {
        await this.stripAcroFormAndAnnotations(options.pdfFile, options.outputFile);
      }
    } else {
      fieldData.fields = [];

      if (options.outputFile) {
        await this.fs.copyFile(options.pdfFile, options.outputFile);
      }
    }

    if (options.outputFile) {
      const buf = await this.fs.readFile(options.outputFile);
      fieldData.md5 = (0, _md.default)(buf.buffer);
    }

    await this.fs.writeFile(options.dataFile, _json.default.stringify(fieldData, undefined, "  "));
  }

  async strip(options) {
    (0, _assert.default)(options.pdfFile, "Must specify a PDF from which to remove the AcroForm");
    (0, _assert.default)(this.fs.existsSync(options.pdfFile), `File '${options.pdfFile}' does not exist`);
    (0, _assert.default)(options.outputFile, `No output file specified`);
    await this.stripAcroFormAndAnnotations(options.pdfFile, options.outputFile);
  }

  async stripAcroFormAndAnnotations(pdfFile, outputFile) {
    // This strips the AcroForm and page annotations as a side-effect
    // merging them into a new page.
    const pdfWriter = _hummus.default.createWriter(outputFile);

    const pdfReader = _hummus.default.createReader(pdfFile);

    const copyingContext = pdfWriter.createPDFCopyingContext(pdfReader); // Next, iterate through the pages from the source document

    const numPages = pdfReader.getPagesCount();

    for (let i = 0; i < numPages; i++) {
      const page = pdfReader.parsePage(i);
      const pageMediaBox = page.getMediaBox();
      const newPage = pdfWriter.createPage(...pageMediaBox); // Merge the page; this will also remove annotations.

      copyingContext.mergePDFPageToPage(newPage, i);
      pdfWriter.writePage(newPage);
    }

    pdfWriter.end();
  }

  async fill(options) {
    (0, _assert.default)(options.pdfFile, "Must specify an input PDF file");
    (0, _assert.default)(this.fs.existsSync(options.pdfFile), `File '${options.pdfFile}' does not exist`);
    (0, _assert.default)(options.outputFile, "No output file specified");
    (0, _assert.default)(options.dataFile && !options.data || !options.dataFile && options.data, "Must specify a data file or data");

    if (!options.fontSize) {
      options.fontSize = 12;
    }

    let data = options.data;

    if (!data) {
      try {
        data = await _json.default.parse(await this.fs.readFile(options.dataFile, {
          encoding: "utf8"
        }));
      } catch (e) {
        throw new Error(`Unable to read data file '${options.dataFile}'. ${e.message}`);
      }
    }

    if (data.md5) {
      const buf = await this.fs.readFile(options.pdfFile);

      if ((0, _md.default)(buf.buffer) !== data.md5) {
        throw new Error(`MD5 for ${options.pdfFile} does not match the one in the data`);
      }
    }

    this.pdfWriter = _hummus.default.createWriterToModify(options.pdfFile, {
      modifiedFilePath: options.outputFile
    });
    this.pdfReader = this.pdfWriter.getModifiedFileParser();
    let font = null;
    let fontDims = null;

    if (options.fontFile) {
      font = this.pdfWriter.getFontForFile(options.fontFile);
      fontDims = font.calculateTextDimensions("X", options.fontSize);
    }

    const catalogDict = this.pdfReader.queryDictionaryObject(this.pdfReader.getTrailer(), "Root").toPDFDictionary();

    if (catalogDict.exists("AcroForm")) {
      this.log.warning("PDF still has an AcroForm");
    }

    const numPages = this.pdfReader.getPagesCount();

    for (let i = 0; i < numPages; i++) {
      const pageModifier = new _hummus.default.PDFPageModifier(this.pdfWriter, i, true);
      let pageContext = pageModifier.startContext().getContext();
      const fields = data.fields.filter(f => f.page === i);

      for (let field of fields) {
        if (!field.name) {
          throw new Error(`Field at index ${i} does not have a 'name' property`);
        }

        if (!field.rect) {
          throw new Error(`Field at index ${i} does not have a 'rect' property`);
        }

        const name = field.name;
        const value = field.value;
        const x = field.rect[0];
        const y = field.rect[1];
        const w = field.rect[2] - x;
        const h = field.rect[3] - y;

        switch (field.type) {
          case "highlight":
            pageContext.q().rg(1, 1, 0.6).re(x, y, w, h).f().Q();
            break;

          case "plaintext":
            if (!font) {
              throw new Error(`Field '${name}'; a font file must be specified for 'plaintext' fields`);
            }

            pageContext.q().BT().g(0).Ts(h / 6.0) // Text rise Table 5.2
            .Tm(1, 0, 0, 1, x, y).Tf(font, options.fontSize).Tj(" " + ((value === null || value === void 0 ? void 0 : value.toString()) || "")).ET().Q();
            break;

          case "qrcode":
            const pngFileName = await _tmpPromise.default.tmpName({
              postfix: ".png"
            });
            await _qrcode.default.toFile(pngFileName, (value === null || value === void 0 ? void 0 : value.toString()) || "12345");
            pageModifier.endContext();
            let imageXObject = this.pdfWriter.createFormXObjectFromPNG(pngFileName);
            const imageDims = this.pdfWriter.getImageDimensions(pngFileName);
            pageContext = pageModifier.startContext().getContext();
            pageContext.q().cm(w / imageDims.width, 0, 0, h / imageDims.height, x, y).doXObject(imageXObject).Q();

            _fsExtra.default.unlinkSync(pngFileName);

            break;

          case "checkbox":
            pageContext.q().G(0).w(2.5);

            if (options.checkboxBorders) {
              pageContext.J(2).re(x, y, w, h).S();
            }

            if (!!value) {
              const dx = w / 5.0;
              const dy = h / 5.0;
              pageContext.J(1).m(x + dx, y + dy).l(x + w - dx, y + h - dy).S().m(x + dx, y + h - dy).l(x + w - dy, y + dy).S();
            }

            pageContext.Q();
            break;

          case "signhere":
            const halfH = h / 2;

            if (!font) {
              throw new Error("Font file must be specified for signhere fields");
            }

            pageModifier.endContext();
            const gsID = this.createExtGState(0.5);
            const formXObject = this.pdfWriter.createFormXObject(0, 0, w, h);
            const gsName = formXObject.getResourcesDictionary().addExtGStateMapping(gsID);
            formXObject.getContentContext().q().gs(gsName).rg(1, 0.6, 1).m(0, halfH).l(halfH, 0).l(w, 0).l(w, h).l(halfH, h).f().G(0).J(0).w(1).m(halfH, h).l(0, halfH).l(halfH, 0).S().w(2).m(halfH, 0).l(w, 0).l(w, h).l(halfH, h).S().BT().g(0).Tm(1, 0, 0, 1, halfH, halfH - fontDims.height / 2.0).Tf(font, 12).Tj(`Sign Here ${(value === null || value === void 0 ? void 0 : value.toString()) || ""}`).ET().Q();
            this.pdfWriter.endFormXObject(formXObject);
            pageContext = pageModifier.startContext().getContext();
            const q = Math.PI / 4.0; // 45 degrees
            // The sign-here arrow is the same height as the field box,
            // points to the bottom left corner of the box and is at 45 degrees

            pageContext.q().cm(1, 0, 0, 1, x, y) // Translate
            .cm(Math.cos(q), Math.sin(q), -Math.sin(q), Math.cos(q), 0, 0) // Rotate
            .cm(1, 0, 0, 1, 0, -halfH) // Translate
            // NOTE: The coordinate space of the XObjects is the same as the page!
            .doXObject(formXObject).Q();
            break;

          default:
            if (field.type === undefined) {
              this.log.warning(`Field '${field.name}' hos no 'type' defined`);
            } else {
              this.log.warning(`Field '${field.name}' is of unknown type '${field.type}'`);
            }

            break;
        }
      }

      pageModifier.endContext().writePage();
    }

    this.pdfWriter.end();
  }

  createExtGState(opacity) {
    const context = this.pdfWriter.getObjectsContext();
    const id = context.startNewIndirectObject();
    const dict = context.startDictionary(); // See Section 4.3.4

    dict.writeKey("type").writeNameValue("ExtGState").writeKey("ca"); // Non-stroking opacity

    context.writeNumber(opacity).endLine();
    dict.writeKey("CA"); // Stroking opacity

    context.writeNumber(opacity).endLine();
    dict.writeKey("SA"); // Turn on stroke adjustment

    context.writeBoolean(true).endLine().endDictionary(dict);
    return id;
  }

  async watermark(options) {
    (0, _assert.default)(options.pdfFile, "Must specify a PDF from which to remove the AcroForm");
    (0, _assert.default)(this.fs.existsSync(options.pdfFile), `File '${options.pdfFile}' does not exist`);
    (0, _assert.default)(options.watermarkFile, "No watermark file specified");
    (0, _assert.default)(this.fs.existsSync(options.watermarkFile), `File '${options.watermarkFile}' does not exist`);
    (0, _assert.default)(options.outputFile, "No output file specified");
    this.pdfWriter = _hummus.default.createWriter(options.outputFile);
    this.pdfReader = _hummus.default.createReader(options.pdfFile);
    const copyingContext = this.pdfWriter.createPDFCopyingContext(this.pdfReader);

    const getPDFPageInfo = (pdfFile, pageNum) => {
      const pdfReader = this.hummus.createReader(pdfFile);
      const page = pdfReader.parsePage(pageNum);
      return {
        mediaBox: page.getMediaBox()
      };
    }; // First, read in the watermark PDF and create a


    const watermarkInfo = getPDFPageInfo(options.watermarkFile, 0);
    const formIDs = this.pdfWriter.createFormXObjectsFromPDF(options.watermarkFile, _hummus.default.ePDFPageBoxMediaBox); // Next, iterate through the pages from the source document

    const numPages = this.pdfReader.getPagesCount();

    for (let i = 0; i < numPages; i++) {
      const page = this.pdfReader.parsePage(i);
      const pageMediaBox = page.getMediaBox();
      const newPage = this.pdfWriter.createPage(...pageMediaBox); // Merge the page; this will also remove annotations.

      copyingContext.mergePDFPageToPage(newPage, i);
      const pageContext = this.pdfWriter.startPageContentContext(newPage);
      pageContext.q().cm(1, 0, 0, 1, (pageMediaBox[2] - watermarkInfo.mediaBox[2]) / 2, (pageMediaBox[3] - watermarkInfo.mediaBox[3]) / 2).doXObject(newPage.getResourcesDictionary().addFormXObjectMapping(formIDs[0])).Q();
      this.pdfWriter.writePage(newPage);
    }

    this.pdfWriter.end();
  }

  async merge(options) {
    (0, _assert.default)(options.fromJsonFile, "A from JSON file must be given");
    (0, _assert.default)(options.toJsonFile, "A from JSON file must be given");

    const fromData = _json.default.parse(await this.fs.readFile(options.fromJsonFile));

    const toData = _json.default.parse(await this.fs.readFile(options.toJsonFile));

    const toFieldMap = new Map(toData.fields.map(field => [field.name, field]));

    for (const fromField of fromData.fields) {
      let toField = toFieldMap.get(fromField.name);

      if (toField) {
        toField.rect = fromField.rect;
        toField.page = fromField.page;
      } else {
        toField = { ...fromField
        };
        toData.fields.push(toField);
        toFieldMap.set(toField.name, toField);
      }
    }

    await this.fs.writeFile(options.toJsonFile, _json.default.stringify(toData, undefined, "  "));
  }

  async run(argv) {
    const options = {
      string: ["output-file", "watermark-file", "data-file", "font-file", "font-size"],
      boolean: ["help", "version", "checkbox-borders", "debug"],
      alias: {
        o: "output-file",
        w: "watermark-file",
        d: "data-file",
        f: "font-file",
        s: "font-size",
        c: "checkbox-borders"
      }
    };
    const args = (0, _minimist.default)(argv, options);
    this.debug = args.debug;
    let command = "help";

    if (args._.length > 0) {
      command = args._[0].toLowerCase();

      args._.shift();
    }

    if (args.version) {
      this.log.info(`${_version.fullVersion}`);
      return 0;
    }

    switch (command) {
      case "concat":
        if (args.help) {
          this.log.info(`
Usage: ${this.toolName} concat <pdf1> <pdf2> [<pdf3> ...] [options]

Options:
  --output-file, -o  Output PDF file

Notes:
  File will be concatenated in the order in which they are given.
`);
          return 0;
        }

        return await this.concat({
          pdfFiles: args._,
          outputFile: args["output-file"]
        });

      case "fields":
        if (args.help) {
          this.log.info(`
Usage: ${this.toolName} fields <pdf>

Options:
--data-file, -d         Output JSON5 file
--output-file, -o       Optional output PDF stripped of AcroForm and annotations.
                        Adds 'md5' field to the output JSON5.

Notes:
Outputs a JSON5 file containing information for all the AcroForm fields in the document.
If an output file is specified a stripped PDF will be generated (see 'strip' command)
and an MD5 hash for the file will be included in the data file.
`);
          return 0;
        }

        return await this.fields({
          pdfFile: args._[0],
          dataFile: args["data-file"],
          outputFile: args["output-file"]
        });

      case "strip":
        if (args.help) {
          this.log.info(`
Usage: ${this.toolName} strip <pdf> [options]

Options:
  --output-file, -o    Output PDF file

Notes:
Strips any AcroForm and page annotations from the document.
`);
          return 0;
        }

        return await this.strip({
          pdfFile: args._[0],
          outputFile: args["output-file"]
        });

      case "merge":
        if (args.help) {
          this.log.info(`
  Usage: ${this.toolName} merge <from-json-file> <to-json-file>

  Notes:
  Merges the pages and rectangles and any new entries from one JSON5 data file another.
  The merge will never delete fields, only add or modify them.
  `);
          return 0;
        }

        return await this.merge({
          fromJsonFile: args._[0],
          toJsonFile: args._[1]
        });

      case "watermark":
        if (args.help) {
          this.log.info(`
Usage: ${this.toolName} watermark <pdf> [options]

Options:
  --watermark-file , -w   Watermarked PDF document
  --output-file, -o       Output PDF file

Notes:
Adds a watermark images to the existing content of each page of the given PDF.
`);
          return 0;
        }

        return await this.watermark({
          pdfFile: args._[0],
          watermarkFile: args["watermark-file"],
          outputFile: args["output-file"]
        });

      case "fill":
        if (args.help) {
          this.log.info(`
Usage: ${this.toolName} fill <pdf> [options]

Options:
--output-file, -o       Output PDF file
--data-file, -d         Input JSON5 data file
--font-file, -f         Input font file name to use for text fields
--font-size, -s         Input font size in points
--checkbox-borders, -c  Put borders around checkboxes

Notes:
Inserts 'form' data into the pages of the PDF.
`);
          return 0;
        }

        return await this.fill({
          pdfFile: args._[0],
          outputFile: args["output-file"],
          dataFile: args["data-file"],
          fontFile: args["font-file"],
          fontSize: parseInt(args["font-size"]),
          checkboxBorders: !!args["checkbox-borders"]
        });

      case "help":
        this.log.info(`
Usage: ${this.toolName} <cmd> [options]

Commands:
help              Shows this help
concat            Concatenate two or more PDFs
fields            Extract the field data from a PDF and optionally
                  create a PDF stripped of its AcroForm and annotations.
                  Generates an MD5 hash for the stripped PDF.
strip             Strip an AcroForm from a PDF
watermark         Add a watermark to every page of a PDF. Strips
                  AcroForms and annotations in the resulting file.
fill              Fill-in "fields" defined in a JSON5 file with data,
                  checking against existing MD5 has for changes.

Global Options:
  --help          Shows this help.
  --version       Shows the tool version.
`);
        return 0;

      default:
        this.log.error(`Unknown command ${command}.  Use --help to see available commands`);
        return -1;
    }

    return 0;
  }

}) || _class;

exports.PDFTool = PDFTool;
//# sourceMappingURL=PDFTool.js.map