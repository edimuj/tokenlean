import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractRubySymbols } from './symbols-ruby.mjs';

describe('extractRubySymbols', () => {
  it('extracts top-level methods', () => {
    const code = `def greet(name)
  puts "Hello #{name}"
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'def greet(name)');
  });

  it('extracts classes with methods', () => {
    const code = `class Server
  def initialize(port)
    @port = port
  end

  def start
    listen
  end
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.classes.length, 1);
    assert.equal(symbols.classes[0].sig, 'class Server');
    assert.equal(symbols.classes[0].methods.length, 2);
  });

  it('extracts class inheritance', () => {
    const code = `class AppError < StandardError
  def message
    "oops"
  end
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.classes[0].sig, 'class AppError < StandardError');
  });

  it('extracts class methods (self.)', () => {
    const code = `class Factory
  def self.create(attrs)
    new(attrs)
  end
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.classes[0].methods.length, 1);
    assert.ok(symbols.classes[0].methods[0].name.includes('self.create'));
  });

  it('extracts attr_accessor/reader/writer', () => {
    const code = `class User
  attr_accessor :name, :email
  attr_reader :id
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.classes[0].attrs.length, 2);
    assert.deepEqual(symbols.classes[0].attrs[0].names, ['name', 'email']);
    assert.equal(symbols.classes[0].attrs[0].kind, 'attr_accessor');
  });

  it('tracks visibility modifiers', () => {
    const code = `class Service
  def public_method
  end

  private

  def secret_method
  end
end`;
    const symbols = extractRubySymbols(code);
    const methods = symbols.classes[0].methods;
    assert.equal(methods[0].visibility, 'public');
    assert.equal(methods[1].visibility, 'private');
  });

  it('extracts modules', () => {
    const code = `module Helpers
  def format(text)
  end
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.modules.length, 1);
    assert.equal(symbols.modules[0], 'module Helpers');
  });

  it('extracts include/extend mixins', () => {
    const code = `class Worker
  include Logging
  extend ClassMethods
end`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.classes[0].mixins.length, 2);
    assert.equal(symbols.classes[0].mixins[0].kind, 'include');
    assert.equal(symbols.classes[0].mixins[0].name, 'Logging');
  });

  it('extracts constants', () => {
    const code = `class Config
  MAX_RETRIES = 3
  TIMEOUT = 30
end

VERSION = "1.0.0"`;
    const symbols = extractRubySymbols(code);
    assert.equal(symbols.classes[0].constants.length, 2);
    assert.equal(symbols.constants.length, 1);
  });

  it('handles nested classes', () => {
    const code = `class Outer
  class Inner
    def inner_method
    end
  end

  def outer_method
  end
end`;
    const symbols = extractRubySymbols(code);
    // Should have both Outer and Inner classes
    assert.equal(symbols.classes.length, 2);
  });

  it('returns empty for non-Ruby content', () => {
    const symbols = extractRubySymbols('just some text');
    assert.equal(symbols.classes.length, 0);
    assert.equal(symbols.functions.length, 0);
  });
});
