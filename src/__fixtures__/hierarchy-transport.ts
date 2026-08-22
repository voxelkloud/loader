// TEST-ONLY. A real RFC 9110 Range server over an in-memory buffer, plus
// switchable misbehaviours, so dedup, request counts, the concurrency cap and
// cancellation are asserted without spies or fake timers.

import type { FetchLike } from "../types.js";

export interface TransportBehaviour {
  /** Answer 200 with the whole file, ignoring Range (potree/potree#1078). */
  readonly ignoreRange?: boolean;
  /** Answer 206 but return fewer bytes than asked for. */
  readonly truncate?: number;
  /** Answer 206 but return more bytes than asked for. */
  readonly overlong?: number;
  /** Omit the Content-Range header, as a cross-origin server would. */
  readonly noContentRange?: boolean;
  /** Answer this status to every request. */
  readonly status?: number;
  /** Fail the first n requests with a network error, then behave. */
  readonly flaky?: number;
  /** Never resolve (until aborted). */
  readonly hang?: boolean;
  /** Reject with this error instead of responding. */
  readonly reject?: () => unknown;
}

export interface RecordedRequest {
  readonly url: string;
  readonly range: string | null;
  readonly signal: AbortSignal | undefined;
  aborted: boolean;
}

export interface TestTransport {
  readonly fetch: FetchLike;
  readonly requests: RecordedRequest[];
  /** Requests that carried a Range header. */
  rangeRequests(): RecordedRequest[];
  /** Highest number of requests in flight at once. */
  readonly peakConcurrency: () => number;
}

function parseRange(header: string | null): [number, number] | undefined {
  if (header === null) return undefined;
  const m = /^bytes=(\d+)-(\d+)$/.exec(header.trim());
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2])];
}

export function makeTransport(
  bytes: Uint8Array,
  behaviour: TransportBehaviour = {},
): TestTransport {
  const requests: RecordedRequest[] = [];
  let failuresLeft = behaviour.flaky ?? 0;
  let inFlight = 0;
  let peak = 0;

  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    const rec: RecordedRequest = {
      url,
      range: headers.get("Range"),
      signal: init?.signal ?? undefined,
      aborted: false,
    };
    requests.push(rec);

    inFlight++;
    if (inFlight > peak) peak = inFlight;
    const done = () => {
      inFlight--;
    };

    try {
      if (behaviour.reject) throw behaviour.reject();

      if (failuresLeft > 0) {
        failuresLeft--;
        throw new TypeError("Failed to fetch");
      }

      if (behaviour.hang) {
        await new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) return;
          if (signal.aborted) {
            rec.aborted = true;
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              rec.aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }

      if (behaviour.status !== undefined && behaviour.status !== 200) {
        return new Response("error", {
          status: behaviour.status,
          statusText: "Test",
        });
      }

      const range = parseRange(rec.range);

      if (range === undefined || behaviour.ignoreRange) {
        // Whole file, status 200.
        return new Response(bytes.slice(), {
          status: 200,
          statusText: "OK",
          headers: { "content-length": String(bytes.byteLength) },
        });
      }

      const [start, end] = range;
      if (start >= bytes.byteLength) {
        return new Response("", {
          status: 416,
          statusText: "Range Not Satisfiable",
          headers: { "content-range": `bytes */${bytes.byteLength}` },
        });
      }

      let slice = bytes.slice(start, Math.min(end + 1, bytes.byteLength));
      if (behaviour.truncate !== undefined) {
        slice = slice.slice(0, behaviour.truncate);
      }
      if (behaviour.overlong !== undefined) {
        const grown = new Uint8Array(slice.byteLength + behaviour.overlong);
        grown.set(slice);
        slice = grown;
      }

      const responseHeaders: Record<string, string> = {
        "accept-ranges": "bytes",
      };
      if (!behaviour.noContentRange) {
        responseHeaders["content-range"] =
          `bytes ${start}-${Math.min(end, bytes.byteLength - 1)}/${bytes.byteLength}`;
      }

      return new Response(slice, {
        status: 206,
        statusText: "Partial Content",
        headers: responseHeaders,
      });
    } finally {
      done();
    }
  };

  return {
    fetch,
    requests,
    rangeRequests: () => requests.filter((r) => r.range !== null),
    peakConcurrency: () => peak,
  };
}
