/** Preserve FileReader's BOM sniffing at the shared byte-to-text boundary. */
export function decodeDocumentText(bytes: Uint8Array): string {
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    return new TextDecoder(encoding).decode(bytes);
}
