/**
 * Truncated-JSON repair — the "cut off mid-generation" recovery.
 *
 * PROBLEM (diagnosed live): long tool-call generations get cut by the
 * upstream mid-string, e.g.
 *
 *   [{"name":"ask_user","arguments":{"questions":[{"text":"What should the
 *   file be named?"},{"text":"Do you want me to
 *
 * A JSON.parse on this throws → the parser falls back to raw-text
 * passthrough → the client renders the half-finished JSON as assistant
 * text (Open WebUI: "returned full raw tool call not in tool call deltas").
 *
 * REPAIR: track bracket nesting + string state; at the cut, close the open
 * string, drop a dangling trailing comma, and close every open container in
 * reverse order. The result is valid JSON representing everything the model
 * managed to generate — a PARTIAL but structurally sound tool call the
 * client can actually execute.
 *
 * - Balanced/valid JSON is returned UNCHANGED (repair is a no-op when the
 *   stack is empty and no string is open).
 * - Pure heuristic — never throws; worst case the repaired string still
 *   fails JSON.parse and the caller keeps its text fallback.
 */

/**
 * Repair a (possibly truncated) JSON string by closing whatever is left
 * open. Safe to call on valid JSON (identity).
 */
export function repairTruncatedJson(s: string): string {
  if (!s) return s;

  let inStr = false;
  let esc = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "[" || c === "{") stack.push(c);
    else if (c === "]" || c === "}") {
      stack.pop();
    }
  }

  // Nothing left open → already balanced, return as-is.
  if (!inStr && stack.length === 0) return s;

  let out = s;
  if (inStr) out += '"';
  // A dangling trailing comma (e.g. cut right after `[{...},`) would make
  // the repaired JSON invalid — strip it.
  out = out.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) {
    out += stack[i] === "[" ? "]" : "}";
  }
  return out;
}

/**
 * JSON-string-state scanner used by streaming normalizers to detect when a
 * bare JSON container becomes COMPLETE (nesting returns to zero).
 */
export interface JsonBalanceState {
  depth: number;
  inStr: boolean;
  esc: boolean;
  /** Has at least one character been fed (guards the initial depth=0). */
  fed: number;
}

export function freshBalance(): JsonBalanceState {
  return { depth: 0, inStr: false, esc: false, fed: 0 };
}

/**
 * Feed one chunk into the balance scanner.
 * Returns the index (within `chunk`) where nesting FIRST returned to zero
 * after having been open — i.e. the container is complete at that index —
 * or -1 while still open / not yet started.
 */
export function feedBalance(st: JsonBalanceState, chunk: string): number {
  let completeAt = -1;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (st.esc) {
      st.esc = false;
      st.fed++;
      continue;
    }
    if (st.inStr) {
      if (c === "\\") {
        st.esc = true;
      } else if (c === '"') {
        st.inStr = false;
      }
      st.fed++;
      continue;
    }
    if (c === '"') {
      st.inStr = true;
      st.fed++;
      continue;
    }
    if (c === "[" || c === "{") {
      st.depth++;
      st.fed++;
      continue;
    }
    if (c === "]" || c === "}") {
      st.depth--;
      st.fed++;
      // Nesting returned to zero after having been open → container
      // complete at this index (first time only).
      if (st.depth === 0 && completeAt === -1 && st.fed > 1) {
        completeAt = i;
      }
      continue;
    }
    st.fed++;
  }
  return completeAt;
}
