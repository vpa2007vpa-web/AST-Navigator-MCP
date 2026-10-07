"use strict";
const path = require("node:path");
const { readFileSync: read, existsSync } = require("node:fs");

function add(a, b) {
  return a + b;
}

const multiply = (a, b) => a * b;

class Calculator {
  #memory = 0;

  static create() {
    return new Calculator();
  }

  store(value) {
    this.#memory = value;
  }
}

function internalHelper() {
  return path.sep + String(read) + String(existsSync);
}

module.exports = { add, multiply, Calculator };
module.exports.version = () => "1.0.0";
