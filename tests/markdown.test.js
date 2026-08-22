import { expect, test } from "bun:test";
import * as smd from "streaming-markdown";
import { DOLLAR_MASK, smdEnd, smdWrite, UND_MASK } from "../src/client/md.js";

/*
 * The client's markdown path. Plain JS, and the only test here that is: the
 * browser bundle is deliberately untyped (tsconfig has no DOM lib and doesn't
 * read it), so a .ts test importing it would drag it into the typechecker.
 *
 * No DOM either — a stub renderer stands in for the hardened one, restoring
 * masked characters the way makeRenderer's add_text does and marking where
 * emphasis actually opened. What comes back is what a reader would see, with
 * <Italic_Und>/<Strong_Und> where smd decided something was emphasis.
 */
function render(chunks) {
  var out = "";
  var r = {
    data: null,
    add_token: (_d, t) => {
      var name = smd.token_to_string(t);
      if (/Italic|Strong/.test(name)) out += "<" + name + ">";
    },
    end_token: () => {},
    add_text: (_d, text) => {
      if (text.indexOf(DOLLAR_MASK) >= 0) text = text.split(DOLLAR_MASK).join("$");
      if (text.indexOf(UND_MASK) >= 0) text = text.split(UND_MASK).join("_");
      out += text;
    },
    set_attr: () => {},
  };
  var p = smd.parser(r);
  for (var c of chunks) smdWrite(p, c);
  smdEnd(p);
  return out;
}

test("an identifier keeps its underscores instead of turning into italics", () => {
  expect(render(["This is a single_choice or multi_choice question, with free_text too."])).toBe(
    "This is a single_choice or multi_choice question, with free_text too.",
  );
  expect(render(["snake_case_name and foo__bar__baz"])).toBe("snake_case_name and foo__bar__baz");
});

test("an identifier split across two deltas still keeps its underscore", () => {
  // The boundary the streaming path holds a character back for: the chunk ends
  // at "single_", and whether that underscore is intraword is only knowable
  // once "choice" arrives.
  expect(render(["read the single_", "choice docs"])).toBe("read the single_choice docs");
});

test("a trailing underscore that never gets a neighbour is still written out", () => {
  expect(render(["ends with under_"])).toBe("ends with under_");
});

test("real emphasis is left alone", () => {
  expect(render(["a _real emphasis_ here"])).toContain("<Italic_Und>");
  // CommonMark reads a leading `__` as strong (it is not intraword), and so do we.
  expect(render(["__init__ is bold"])).toContain("<Strong_Und>");
});

test("code and math keep their underscores verbatim", () => {
  expect(render(["`inline_code_here`"])).toBe("inline_code_here");
  expect(render(["```\nfoo_bar = 1\n```"])).toBe("foo_bar = 1");
  expect(render(["math $x_1 + y_2$ inline"])).toBe("math $x_1 + y_2$ inline");
});
