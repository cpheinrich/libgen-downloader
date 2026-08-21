export const LIBGEN_REQUEST_OPTIONS: RequestInit = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  },
};

export function fetchLibgen(input: string | URL): Promise<Response> {
  return fetch(input, LIBGEN_REQUEST_OPTIONS);
}
