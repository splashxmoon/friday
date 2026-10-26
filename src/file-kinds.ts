/**
 * Which files Friday can actually do something with.
 *
 * Pure on purpose: the picker in the browser and the upload route on the
 * server have to agree, and they can only agree if they ask the same
 * function. Nothing here touches the filesystem, so both sides can import it.
 *
 * The rule is a denylist, and that is the whole point of this file. It used
 * to be an allowlist of about forty extensions, which meant a folder pick
 * silently threw away every Dockerfile, Makefile, lockfile and dotfile, every
 * .mjs and .vue and .scss, every Terraform and Xcode and Gradle file, and
 * anything from a language nobody had thought to add. Measured against a list
 * of ordinary files from real projects it dropped 82% of them — and it said
 * so only as a number, so "attached 40, skipped 190 the agent can't read"
 * read like the folder was mostly junk rather than like the rule was wrong.
 *
 * Text is the default, the way ripgrep and git treat it: a file is text
 * unless something says otherwise. Being wrong in this direction costs one
 * unreadable file in a list; being wrong in the other direction costs the
 * file, silently, and there is no way for anybody to find out.
 */

/**
 * Things that are definitely not text.
 *
 * Only formats whose bytes are meaningless as characters — media, archives,
 * compiled output, binary documents, key material. Anything that could
 * conceivably be opened in an editor is left out of this list on purpose.
 */
const BINARY_EXT = new RegExp(
  `\\.(${[
    // Images and design files.
    "png|jpe?g|gif|webp|bmp|ico|icns|tiff?|avif|heic|heif|psd|ai|sketch|fig|xcf",
    // Audio and video.
    "mp[234]|m4a|m4v|wav|aiff?|flac|ogg|oga|opus|aac|wma|mov|avi|mkv|webm|wmv|flv|mpe?g",
    // Archives and packages.
    "zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|ear|apk|aab|ipa|dmg|pkg|deb|rpm|iso|img",
    // Fonts.
    "woff2?|ttf|otf|eot|ttc",
    // Compiled output.
    "exe|dll|so|dylib|bin|o|a|obj|lib|wasm|class|pyc|pyo|node",
    // Binary documents. PDFs are handled on their own: the model can read one.
    "pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf",
    // Databases and key material.
    "sqlite3?|db|mdb|realm|p12|pfx|jks|keystore|der|crt|cer",
    // Build and debug leftovers.
    "pdb|nib|car|pack|idx",
  ].join("|")})$`,
  "i",
);

/** MIME families that are never text, whatever the name says. */
const BINARY_TYPE = /^(image|video|audio|font)\//;

/**
 * Whether this is something a model can be handed as characters.
 *
 * SVG counts, and so does anything with no extension at all: Dockerfile,
 * Makefile, LICENSE, Procfile and every dotfile live there.
 */
export function isTextLike(name: string, type = ""): boolean {
  if (type.startsWith("text/") || /json|xml|yaml|javascript|typescript|markdown|x-sh|svg/.test(type)) return true;
  if (BINARY_TYPE.test(type)) return false;
  if (type === "application/pdf") return false;
  return !BINARY_EXT.test(name);
}

const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp)$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Whether the agent can do anything with this file at all.
 *
 * The same three shapes resolveAttachments turns into model input: text, an
 * image it can look at, or a PDF. What is left out now is genuinely only
 * media, archives and compiled output — things that would arrive as "binary
 * content not shown" however hard anyone tried.
 */
export function isUsableFile(name: string, type = ""): boolean {
  return isTextLike(name, type) || IMAGE_TYPE.test(type) || IMAGE_EXT.test(name) || type === "application/pdf" || /\.pdf$/i.test(name);
}

/**
 * What to put in a file input's `accept`.
 *
 * Empty, deliberately. An accept list is an allowlist, and an allowlist is
 * exactly what was wrong here: it greyed out the Dockerfile in the picker
 * before anything got a chance to classify it. The rules above decide, and
 * they say what they skipped.
 */
export const ACCEPT_ATTR = "";
