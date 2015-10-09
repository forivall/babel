import convertSourceMap from "convert-source-map";
import moduleFormatters from "../modules";
import OptionManager from "./options/option-manager";
import PluginManager from "./plugin-manager";
import shebangRegex from "shebang-regex";
import { NodePath, Hub } from "babel-traverse";
import isFunction from "lodash/lang/isFunction";
import sourceMap from "source-map";
import generate from "babel-generator";
import codeFrame from "babel-code-frame";
import shuffle from "lodash/collection/shuffle";
import defaults from "lodash/object/defaults";
import includes from "lodash/collection/includes";
import traverse from "babel-traverse";
import resolve from "try-resolve";
import Logger from "./logger";
import Store from "../../store";
import Plugin from "../plugin";
import parse from "../../helpers/parse";
import * as util from  "../../util";
import path from "path";
import * as t from "babel-types";

let errorVisitor = {
  enter(path, state) {
    let loc = path.node.loc;
    if (loc) {
      state.loc = loc;
      path.stop();
    }
  }
};

export default class File extends Store {
  constructor(opts = {}, pipeline) {
    super();
    this.pipeline = pipeline;

    this.log  = new Logger(this, opts.filename || "unknown");
    this.opts = this.initOptions(opts);

    this.buildTransformers();
  }

  transformerDependencies = {};
  dynamicImportTypes      = {};
  dynamicImportIds        = {};
  dynamicImports          = [];
  declarations            = {};
  usedHelpers             = {};
  dynamicData             = {};
  data                    = {};
  ast                     = {};

  metadata = {
    marked: [],

    modules: {
      imports: [],
      exports: {
        exported: [],
        specifiers: []
      }
    }
  };

  hub = new Hub(this);

  static helpers = [
    "inherits",
    "defaults",
    "create-class",
    "create-decorated-class",
    "create-decorated-object",
    "define-decorated-property-descriptor",
    "tagged-template-literal",
    "tagged-template-literal-loose",
    "to-array",
    "to-consumable-array",
    "sliced-to-array",
    "sliced-to-array-loose",
    "object-without-properties",
    "has-own",
    "slice",
    "bind",
    "define-property",
    "async-to-generator",
    "interop-export-wildcard",
    "interop-require-wildcard",
    "interop-require-default",
    "typeof",
    "extends",
    "get",
    "set",
    "new-arrow-check",
    "class-call-check",
    "object-destructuring-empty",
    "temporal-undefined",
    "temporal-assert-defined",
    "self-global",
    "default-props",
    "instanceof",

    // legacy
    "interop-require"
  ];

  static soloHelpers = [];


  initOptions(opts) {
    opts = new OptionManager(this.log, this.pipeline).init(opts);

    if (opts.inputSourceMap) {
      opts.sourceMaps = true;
    }

    if (opts.moduleId) {
      opts.moduleIds = true;
    }

    opts.basename = path.basename(opts.filename, path.extname(opts.filename));

    opts.ignore = util.arrayify(opts.ignore, util.regexify);

    if (opts.only) opts.only = util.arrayify(opts.only, util.regexify);

    defaults(opts, {
      moduleRoot: opts.sourceRoot
    });

    defaults(opts, {
      sourceRoot: opts.moduleRoot
    });

    defaults(opts, {
      filenameRelative: opts.filename
    });

    let basenameRelative = path.basename(opts.filenameRelative);

    defaults(opts, {
      sourceFileName:   basenameRelative,
      sourceMapTarget:  basenameRelative
    });

    //

    if (opts.externalHelpers) {
      this.set("helpersNamespace", t.identifier("babelHelpers"));
    }

    return opts;
  }

  isLoose(key: string) {
    return includes(this.opts.loose, key);
  }

  buildTransformers() {
    let file = this;

    let transformers = this.transformers = {};

    let secondaryStack = [];
    let stack = [];

    // build internal transformers
    for (let key in this.pipeline.transformers) {
      let transformer = this.pipeline.transformers[key];
      let pass = transformers[key] = transformer.buildPass(file);

      if (pass.canTransform()) {
        stack.push(pass);

        if (transformer.metadata.secondPass) {
          secondaryStack.push(pass);
        }

        if (transformer.manipulateOptions) {
          transformer.manipulateOptions(file.opts, file);
        }
      }
    }

    // init plugins!
    let beforePlugins = [];
    let afterPlugins = [];
    let pluginManager = new PluginManager({
      file: this,
      transformers: this.transformers,
      before: beforePlugins,
      after: afterPlugins
    });
    for (let i = 0; i < file.opts.plugins.length; i++) {
      pluginManager.add(file.opts.plugins[i]);
    }
    stack = beforePlugins.concat(stack, afterPlugins);

    // build transformer stack
    this.uncollapsedTransformerStack = stack = stack.concat(secondaryStack);

    // build dependency graph
    for (let pass of (stack: Array)) {
      for (let dep of (pass.plugin.dependencies: Array)) {
        this.transformerDependencies[dep] = pass.key;
      }
    }

    // collapse stack categories
    this.transformerStack = this.collapseStack(stack);
  }

  collapseStack(_stack) {
    let stack  = [];
    let ignore = [];

    for (let pass of (_stack: Array)) {
      // been merged
      if (ignore.indexOf(pass) >= 0) continue;

      let group = pass.plugin.metadata.group;

      // can't merge
      if (!pass.canTransform() || !group) {
        stack.push(pass);
        continue;
      }

      let mergeStack = [];
      for (let pass of (_stack: Array)) {
        if (pass.plugin.metadata.group === group) {
          mergeStack.push(pass);
          ignore.push(pass);
        } else {
          //break;
        }
      }
      shuffle;
      //mergeStack = shuffle(mergeStack);

      let visitors = [];
      for (let pass of (mergeStack: Array)) {
        visitors.push(pass.plugin.visitor);
      }
      let visitor = traverse.visitors.merge(visitors);
      let mergePlugin = new Plugin(group, { visitor });
      stack.push(mergePlugin.buildPass(this));
    }

    return stack;
  }

  set(key: string, val): any {
    return this.data[key] = val;
  }

  setDynamic(key: string, fn: Function) {
    this.dynamicData[key] = fn;
  }

  get(key: string): any {
    let data = this.data[key];
    if (data) {
      return data;
    } else {
      let dynamic = this.dynamicData[key];
      if (dynamic) {
        return this.set(key, dynamic());
      }
    }
  }

  resolveModuleSource(source: string): string {
    let resolveModuleSource = this.opts.resolveModuleSource;
    if (resolveModuleSource) source = resolveModuleSource(source, this.opts.filename);
    return source;
  }

  addImport(source: string, name?: string, type?: string): Object {
    name = name || source;
    let id = this.dynamicImportIds[name];

    if (!id) {
      source = this.resolveModuleSource(source);
      id = this.dynamicImportIds[name] = this.scope.generateUidIdentifier(name);

      let specifiers = [t.importDefaultSpecifier(id)];
      let declar = t.importDeclaration(specifiers, t.stringLiteral(source));
      declar._blockHoist = 3;

      if (type) {
        let modules = this.dynamicImportTypes[type] = this.dynamicImportTypes[type] || [];
        modules.push(declar);
      }

      if (this.transformers["es6.modules"].canTransform()) {
        this.moduleFormatter.importSpecifier(specifiers[0], declar, this.dynamicImports, this.scope);
        this.moduleFormatter.hasLocalImports = true;
      } else {
        this.dynamicImports.push(declar);
      }
    }

    return id;
  }

  attachAuxiliaryComment(node: Object): Object {
    let beforeComment = this.opts.auxiliaryCommentBefore;
    if (beforeComment) {
      node.leadingComments = node.leadingComments || [];
      node.leadingComments.push({
        type: "CommentLine",
        value: " " + beforeComment
      });
    }

    let afterComment = this.opts.auxiliaryCommentAfter;
    if (afterComment) {
      node.trailingComments = node.trailingComments || [];
      node.trailingComments.push({
        type: "CommentLine",
        value: " " + afterComment
      });
    }

    return node;
  }

  addHelper(name: string): Object {
    let isSolo = includes(File.soloHelpers, name);

    if (!isSolo && !includes(File.helpers, name)) {
      throw new ReferenceError(`Unknown helper ${name}`);
    }

    let declar = this.declarations[name];
    if (declar) return declar;

    this.usedHelpers[name] = true;

    if (!isSolo) {
      let generator = this.get("helperGenerator");
      let runtime   = this.get("helpersNamespace");
      if (generator) {
        return generator(name);
      } else if (runtime) {
        let id = t.identifier(t.toIdentifier(name));
        return t.memberExpression(runtime, id);
      }
    }

    let ref = util.template("helper-" + name);

    let uid = this.declarations[name] = this.scope.generateUidIdentifier(name);

    if (t.isFunctionExpression(ref) && !ref.id) {
      ref.body._compact = true;
      ref._generated = true;
      ref.id = uid;
      ref.type = "FunctionDeclaration";
      this.attachAuxiliaryComment(ref);
      this.path.unshiftContainer("body", ref);
    } else {
      ref._compact = true;
      this.scope.push({
        id: uid,
        init: ref,
        unique: true
      });
    }

    return uid;
  }

  addTemplateObject(helperName: string, strings: Array, raw: Array): Object {
    // Generate a unique name based on the string literals so we dedupe
    // identical strings used in the program.
    let stringIds = raw.elements.map(function(string) {
      return string.value;
    });
    let name = `${helperName}_${raw.elements.length}_${stringIds.join(",")}`;

    let declar = this.declarations[name];
    if (declar) return declar;

    let uid = this.declarations[name] = this.scope.generateUidIdentifier("templateObject");

    let helperId = this.addHelper(helperName);
    let init = t.callExpression(helperId, [strings, raw]);
    init._compact = true;
    this.scope.push({
      id: uid,
      init: init,
      _blockHoist: 1.9    // This ensures that we don't fail if not using function expression helpers
    });
    return uid;
  }

  buildCodeFrameError(node, msg, Error = SyntaxError) {
    let loc = node && (node.loc || node._loc);

    let err = new Error(msg);

    if (loc) {
      err.loc = loc.start;
    } else {
      traverse(node, errorVisitor, err);

      err.message += " (This is an error on an internal node. Probably an internal error";

      if (err.loc) {
        err.message += ". Location has been estimated.";
      }

      err.message += ")";
    }

    return err
  }

  mergeSourceMap(map: Object) {
    let inputMap = this.opts.inputSourceMap;

    if (inputMap) {
      let inputMapConsumer   = new sourceMap.SourceMapConsumer(inputMap);
      let outputMapConsumer  = new sourceMap.SourceMapConsumer(map);
      let outputMapGenerator = sourceMap.SourceMapGenerator.fromSourceMap(outputMapConsumer);
      outputMapGenerator.applySourceMap(inputMapConsumer);

      let mergedMap = outputMapGenerator.toJSON();
      mergedMap.sources = inputMap.sources;
      mergedMap.file    = inputMap.file;
      return mergedMap;
    } else {
      return map;
    }
  }

  getModuleFormatter(type: string) {
    if (isFunction(type) || !moduleFormatters[type]) {
      this.log.deprecate("Custom module formatters are deprecated and will be removed in the next major. Please use Babel plugins instead.");
    }

    let ModuleFormatter = isFunction(type) ? type : moduleFormatters[type];

    if (!ModuleFormatter) {
      let loc = resolve.relative(type);
      if (loc) ModuleFormatter = require(loc);
    }

    if (!ModuleFormatter) {
      throw new ReferenceError(`Unknown module formatter type ${JSON.stringify(type)}`);
    }

    return new ModuleFormatter(this);
  }

  parse(code: string) {
    let opts = this.opts;

    //

    let parseOpts = {
      highlightCode: opts.highlightCode,
      nonStandard:   opts.nonStandard,
      sourceType:    opts.sourceType,
      filename:      opts.filename,
      plugins:       {}
    };

    let features = parseOpts.features = {};
    for (let key in this.transformers) {
      let transformer = this.transformers[key];
      features[key] = transformer.canRun();
    }

    parseOpts.looseModules = this.isLoose("es6.modules");
    parseOpts.strictMode = features.strict;

    this.log.debug("Parse start");
    let ast = parse(code, parseOpts);
    this.log.debug("Parse stop");
    return ast;
  }

  _addAst(ast) {
    this.path = NodePath.get({
      hub: this.hub,
      parentPath: null,
      parent: ast,
      container: ast,
      key: "program"
    }).setContext();
    this.scope = this.path.scope;
    this.ast   = ast;
  }

  addAst(ast) {
    this.log.debug("Start set AST");
    this._addAst(ast);
    this.log.debug("End set AST");

    this.log.debug("Start module formatter init");
    let modFormatter = this.moduleFormatter = this.getModuleFormatter(this.opts.modules);
    if (modFormatter.init && this.transformers["es6.modules"].canTransform()) {
      modFormatter.init();
    }
    this.log.debug("End module formatter init");
  }

  transform() {
    this.call("pre");
    for (let pass of (this.transformerStack: Array)) {
      pass.transform();
    }
    this.call("post");

    return this.generate();
  }

  wrap(code, callback) {
    code = code + "";

    try {
      if (this.shouldIgnore()) {
        return this.makeResult({ code, ignored: true });
      } else {
        return callback();
      }
    } catch (err) {
      if (err._babel) {
        throw err;
      } else {
        err._babel = true;
      }

      let message = err.message = `${this.opts.filename}: ${err.message}`;

      let loc = err.loc;
      if (loc) {
        err.codeFrame = codeFrame(code, loc.line, loc.column + 1, this.opts);
        message += "\n" + err.codeFrame;
      }

      if (process.browser) {
        // chrome has it's own pretty stringifier which doesn't use the stack property
        // https://github.com/babel/babel/issues/2175
        err.message = message;
      }

      if (err.stack) {
        let newStack = err.stack.replace(err.message, message);
        try {
          err.stack = newStack;
        } catch (e) {
          // `err.stack` may be a readonly property in some environments
        }
      }

      throw err;
    }
  }

  addCode(code: string) {
    code = (code || "") + "";
    code = this.parseInputSourceMap(code);
    this.code = code;
  }

  parseCode() {
    this.parseShebang();
    let ast = this.parse(this.code);
    this.addAst(ast);
  }

  shouldIgnore() {
    let opts = this.opts;
    return util.shouldIgnore(opts.filename, opts.ignore, opts.only);
  }

  call(key: string) {
    for (let pass of (this.uncollapsedTransformerStack: Array)) {
      let fn = pass.plugin[key];
      if (fn) fn.call(pass, this);
    }
  }

  parseInputSourceMap(code: string) {
    let opts = this.opts;

    if (opts.inputSourceMap !== false) {
      let inputMap = convertSourceMap.fromSource(code);
      if (inputMap) {
        opts.inputSourceMap = inputMap.toObject();
        code = convertSourceMap.removeComments(code);
      }
    }

    return code;
  }

  parseShebang() {
    let shebangMatch = shebangRegex.exec(this.code);
    if (shebangMatch) {
      this.shebang = shebangMatch[0];
      this.code = this.code.replace(shebangRegex, "");
    }
  }

  makeResult({ code, map = null, ast, ignored }) {
    let result = {
      metadata: null,
      ignored:  !!ignored,
      code:     null,
      ast:      null,
      map:      map
    };

    if (this.opts.code) {
      result.code = code;
    }

    if (this.opts.ast) {
      result.ast = ast;
    }

    if (this.opts.metadata) {
      result.metadata = this.metadata;
      result.metadata.usedHelpers = Object.keys(this.usedHelpers);
    }

    return result;
  }

  generate() {
    let opts = this.opts;
    let ast  = this.ast;

    let result = { ast };
    if (!opts.code) return this.makeResult(result);

    this.log.debug("Generation start");

    let _result = generate(ast, opts, this.code);
    result.code = _result.code;
    result.map  = _result.map;

    this.log.debug("Generation end");

    if (this.shebang) {
      // add back shebang
      result.code = `${this.shebang}\n${result.code}`;
    }

    if (result.map) {
      result.map = this.mergeSourceMap(result.map);
    }

    if (opts.sourceMaps === "inline" || opts.sourceMaps === "both") {
      result.code += "\n" + convertSourceMap.fromObject(result.map).toComment();
    }

    if (opts.sourceMaps === "inline") {
      result.map = null;
    }

    return this.makeResult(result);
  }
}
