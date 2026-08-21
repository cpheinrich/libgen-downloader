import meow from "meow";

export const cli = meow(
  `
	Usage
	  $ libgen-downloader <input>

	Options
    -s, --search <query>       search for a book interactively
        --best <query>         find and ingest the best copy of a book
    -l, --list <BOOKS.md>      ingest the best copy of every book in a Markdown list
    -i, --import <file>        import and convert a locally owned book
        --title <title>        override title metadata for --import
        --author <author>      override author metadata for --import
    -o, --output <directory>   library root (default: ~/libgen)
        --pages <number>       result pages to evaluate (default: 2)
        --source-only          retain the source without Markdown conversion
        --format <format>      converted output: canonical, docling, or both
    -b, --bulk <MD5LIST.txt>   legacy MD5 bulk downloading mode
    -u, --url <MD5>            get the download URL
    -d, --download <MD5>       download the file by MD5
    -h, --help                 display help

	Examples
    $ libgen-downloader    (start the app in interactive mode without flags)
    $ libgen-downloader -s "The Art of War"
    $ libgen-downloader --best "The Art of War by Sun Tzu"
    $ libgen-downloader --list ./reading-list.md
    $ libgen-downloader --import ~/my-library/book.epub
    $ libgen-downloader -b ./MD5_LIST_1695686580524.txt
    $ libgen-downloader -u 1234567890abcdef1234567890abcdef
    $ libgen-downloader -d 1234567890abcdef1234567890abcdef
`,
  {
    importMeta: import.meta,
    flags: {
      search: {
        type: "string",
        shortFlag: "s",
      },
      best: {
        type: "string",
      },
      list: {
        type: "string",
        shortFlag: "l",
      },
      import: {
        type: "string",
        shortFlag: "i",
      },
      title: {
        type: "string",
      },
      author: {
        type: "string",
      },
      output: {
        type: "string",
        shortFlag: "o",
      },
      pages: {
        type: "string",
        default: "2",
      },
      sourceOnly: {
        type: "boolean",
        default: false,
      },
      format: {
        type: "string",
        default: "canonical",
      },
      bulk: {
        type: "string",
        shortFlag: "b",
      },
      url: {
        type: "string",
        shortFlag: "u",
      },
      download: {
        type: "string",
        shortFlag: "d",
      },
      help: {
        type: "boolean",
        shortFlag: "h",
      },
    },
  }
);
