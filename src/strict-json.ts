export type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | StrictJsonArray
  | StrictJsonObject;

export interface StrictJsonArray extends Array<StrictJsonValue> {}

export interface StrictJsonObject {
  [key: string]: StrictJsonValue;
}

export type StrictJsonOptions = {
  maxBytes: number;
  maxDepth: number;
};

export class StrictJsonParseError extends Error {}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isHexDigit(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ((value >= "0" && value <= "9") ||
      (value >= "a" && value <= "f") ||
      (value >= "A" && value <= "F"))
  );
}

function isResourceLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

class StrictJsonParser {
  private position = 0;

  public constructor(
    private readonly source: string,
    private readonly maxDepth: number
  ) {}

  public parseDocument(): StrictJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position !== this.source.length) {
      this.fail();
    }
    return value;
  }

  private parseValue(depth: number): StrictJsonValue {
    const current = this.source[this.position];
    switch (current) {
      case "{":
        return this.parseObject(depth + 1);
      case "[":
        return this.parseArray(depth + 1);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (current === "-" || isDigit(current)) {
          return this.parseNumber();
        }
        this.fail();
    }
  }

  private parseObject(depth: number): StrictJsonObject {
    if (depth > this.maxDepth) {
      this.fail();
    }
    this.expect("{");
    this.skipWhitespace();
    const result = Object.create(null) as StrictJsonObject;
    if (this.consume("}")) {
      return result;
    }

    while (true) {
      if (this.source[this.position] !== '"') {
        this.fail();
      }
      const key = this.parseString();
      if (Object.hasOwn(result, key)) {
        this.fail();
      }
      this.skipWhitespace();
      this.expect(":");
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume("}")) {
        return result;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): StrictJsonArray {
    if (depth > this.maxDepth) {
      this.fail();
    }
    this.expect("[");
    this.skipWhitespace();
    const result: StrictJsonArray = [];
    if (this.consume("]")) {
      return result;
    }

    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume("]")) {
        return result;
      }
      this.expect(",");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.expect('"');
    let result = "";
    while (this.position < this.source.length) {
      const current = this.source[this.position++]!;
      if (current === '"') {
        return result;
      }
      if (current === "\\") {
        const escape = this.source[this.position++];
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            result += escape;
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u":
            result += this.parseUnicodeEscape();
            break;
          default:
            this.fail();
        }
        continue;
      }
      if (current.charCodeAt(0) <= 0x1f) {
        this.fail();
      }
      result += current;
    }
    this.fail();
  }

  private parseUnicodeEscape(): string {
    const start = this.position;
    for (let offset = 0; offset < 4; offset++) {
      if (!isHexDigit(this.source[this.position + offset])) {
        this.fail();
      }
    }
    this.position += 4;
    return String.fromCharCode(Number.parseInt(this.source.slice(start, start + 4), 16));
  }

  private parseLiteral<T extends null | boolean>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.position)) {
      this.fail();
    }
    this.position += literal.length;
    return value;
  }

  private parseNumber(): number {
    const start = this.position;
    this.consume("-");
    if (this.consume("0")) {
      // A following digit is rejected by the normal trailing-token check.
    } else {
      if (!isDigit(this.source[this.position]) || this.source[this.position] === "0") {
        this.fail();
      }
      while (isDigit(this.source[this.position])) {
        this.position++;
      }
    }
    if (this.consume(".")) {
      if (!isDigit(this.source[this.position])) {
        this.fail();
      }
      while (isDigit(this.source[this.position])) {
        this.position++;
      }
    }
    const exponent = this.source[this.position];
    if (exponent === "e" || exponent === "E") {
      this.position++;
      const sign = this.source[this.position];
      if (sign === "+" || sign === "-") {
        this.position++;
      }
      if (!isDigit(this.source[this.position])) {
        this.fail();
      }
      while (isDigit(this.source[this.position])) {
        this.position++;
      }
    }
    const value = Number(this.source.slice(start, this.position));
    if (!Number.isFinite(value)) {
      this.fail();
    }
    return value;
  }

  private skipWhitespace(): void {
    while (true) {
      const current = this.source[this.position];
      if (current !== " " && current !== "\t" && current !== "\n" && current !== "\r") {
        return;
      }
      this.position++;
    }
  }

  private expect(value: string): void {
    if (!this.consume(value)) {
      this.fail();
    }
  }

  private consume(value: string): boolean {
    if (this.source.startsWith(value, this.position)) {
      this.position += value.length;
      return true;
    }
    return false;
  }

  private fail(): never {
    throw new StrictJsonParseError();
  }
}

export function parseStrictJsonBytes(
  bytes: Uint8Array,
  options: StrictJsonOptions
): StrictJsonValue {
  if (!isResourceLimit(options.maxBytes) || !isResourceLimit(options.maxDepth)) {
    throw new StrictJsonParseError();
  }
  if (bytes.byteLength > options.maxBytes) {
    throw new StrictJsonParseError();
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonParseError();
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return new StrictJsonParser(source, options.maxDepth).parseDocument();
  } catch (error) {
    if (error instanceof StrictJsonParseError) {
      throw error;
    }
    throw new StrictJsonParseError();
  }
}
