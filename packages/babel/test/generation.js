var generate = require("../lib/generation");
var fixtures = require("mocha-fixtures");
var assert   = require("assert");
var parse    = require("../lib/helpers/parse");
var chai     = require("chai");
var t        = require("../lib/types");
var _        = require("lodash");

suite("generation", function () {
  test("completeness", function () {
    _.each(t.VISITOR_KEYS, function (keys, type) {
      assert.ok(!!generate.CodeGenerator.prototype[type], type + " should exist");
    });

    _.each(generate.CodeGenerator.prototype, function (fn, type) {
      if (!/[A-Z]/.test(type[0])) return;
      assert.ok(t.VISITOR_KEYS[type], type + " should not exist");
    });
  });
});

_.each(require("./_transformation-helper").fixtures.generation, function (testSuite) {
  suite("generation/" + testSuite.title, function () {
    _.each(testSuite.tests, function (task) {
      test(task.title, !task.disabled && function () {
        var expect = task.expect;
        var actual = task.actual;

        var actualAst = parse(actual.code, {
          filename: actual.loc,
          nonStandard: true,
          strictMode: false,
          sourceType: "module",
          features: {
            "es7.decorators": true,
            "es7.comprehensions": true,
            "es7.asyncFunctions": true,
            "es7.exportExtensions": true,
            "es7.functionBind": true
          }
        });

        var actualCode = generate(actualAst, task.options, actual.code).code;
        chai.expect(actualCode).to.equal(expect.code, actual.loc + " !== " + expect.loc);
      });
    });
  });
});
