import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractGoSymbols } from './symbols-go.mjs';

describe('extractGoSymbols', () => {
  it('extracts functions', () => {
    const code = `func main() {
	fmt.Println("hello")
}`;
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'func main()');
  });

  it('extracts functions with receivers', () => {
    const code = 'func (s *Server) Start(port int) error {';
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.functions.length, 1);
    assert.equal(symbols.functions[0], 'func (s *Server) Start(port int) error');
  });

  it('extracts struct types', () => {
    const code = 'type Config struct {';
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.types[0], 'type Config struct');
  });

  it('extracts interface types', () => {
    const code = 'type Handler interface {';
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.types[0], 'type Handler interface');
  });

  it('extracts multiple declarations', () => {
    const code = `type Request struct {
	URL string
}

type Response struct {
	Body []byte
}

func HandleRequest(r *Request) *Response {
	return nil
}

func (r *Response) String() string {
	return ""
}`;
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 2);
    assert.equal(symbols.functions.length, 2);
  });

  it('returns empty for non-Go content', () => {
    const symbols = extractGoSymbols('just some text\nnothing here');
    assert.equal(symbols.types.length, 0);
    assert.equal(symbols.functions.length, 0);
  });

  it('extracts func-typed type declarations', () => {
    const code = 'type Handler func(w http.ResponseWriter, r *http.Request)';
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.types[0], 'type Handler func(w http.ResponseWriter, r *http.Request)');
  });

  it('extracts type aliases', () => {
    const code = 'type MyInt = int';
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.types[0], 'type MyInt = int');
  });

  it('extracts map types', () => {
    const code = 'type StringMap map[string]string';
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 1);
    assert.equal(symbols.types[0], 'type StringMap map[string]string');
  });

  it('extracts all extended type forms together', () => {
    const code = `type Config struct {
\tHost string
}
type Handler func(w http.ResponseWriter)
type MyInt = int
type StringMap map[string]string`;
    const symbols = extractGoSymbols(code);
    assert.equal(symbols.types.length, 4);
  });
});
