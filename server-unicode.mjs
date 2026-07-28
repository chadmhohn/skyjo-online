export function isWellFormedUnicode(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

export function toWellFormedUnicode(value) {
  const input = String(value ?? '');
  let output = '';
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += '\uFFFD';
      }
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      output += '\uFFFD';
    } else {
      output += input[index];
    }
  }
  return output;
}

export function wellFormedUTF16Prefix(value, maximumCodeUnits) {
  if (!Number.isSafeInteger(maximumCodeUnits) || maximumCodeUnits < 0) return '';
  const input = toWellFormedUnicode(value);
  if (input.length <= maximumCodeUnits) return input;
  let output = input.slice(0, maximumCodeUnits);
  const finalCodeUnit = output.charCodeAt(output.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) output = output.slice(0, -1);
  return output;
}
