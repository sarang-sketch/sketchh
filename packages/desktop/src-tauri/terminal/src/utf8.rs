//! Turning a pseudo-terminal's byte stream into text without breaking characters.
//!
//! A read returns whatever bytes the terminal had ready, and a multi-byte UTF-8
//! character — `é`, `→`, a box-drawing line, an emoji in a prompt — is routinely cut
//! in two by a read boundary. Decoding each read on its own turns both halves into
//! replacement characters, which is the classic "garbled prompt" bug of naive
//! terminals. This decoder keeps an incomplete trailing sequence until the next read
//! completes it, and only bytes that are invalid in context become U+FFFD.

/// Incremental UTF-8 decoder. Output is exactly what [`String::from_utf8_lossy`] would
/// produce for the whole stream at once, delivered piece by piece.
#[derive(Debug, Default)]
pub struct Utf8Stream {
    /// At most three bytes: the start of a character the next read will finish.
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode one read. An incomplete character at the end is held back, not lost.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);

        let mut out = String::with_capacity(data.len());
        let mut rest: &[u8] = &data;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    // `valid_up_to` is the length of the longest valid prefix.
                    if let Ok(text) = std::str::from_utf8(&rest[..valid]) {
                        out.push_str(text);
                    }
                    match error.error_len() {
                        // Bytes that can never start or continue a character here.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &rest[valid + len..];
                        }
                        // The input simply ended mid-character: wait for the rest.
                        None => {
                            self.pending.extend_from_slice(&rest[valid..]);
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// The stream ended. A character still incomplete now never will be.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

#[cfg(test)]
mod tests {
    use super::Utf8Stream;

    #[test]
    fn ascii_passes_through_unchanged() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.push(b"npm test\r\n"), "npm test\r\n");
        assert_eq!(stream.finish(), "");
    }

    #[test]
    fn a_two_byte_character_split_across_reads_arrives_whole() {
        let mut stream = Utf8Stream::new();
        let bytes = "café".as_bytes();
        let (head, tail) = bytes.split_at(bytes.len() - 1);
        assert_eq!(stream.push(head), "caf");
        assert_eq!(stream.push(tail), "é");
    }

    #[test]
    fn a_four_byte_character_split_three_ways_arrives_whole() {
        let mut stream = Utf8Stream::new();
        let bytes = "ok 🙂".as_bytes();
        let mut out = String::new();
        out.push_str(&stream.push(&bytes[..4]));
        out.push_str(&stream.push(&bytes[4..5]));
        out.push_str(&stream.push(&bytes[5..]));
        assert_eq!(out, "ok 🙂");
    }

    #[test]
    fn every_split_point_of_mixed_text_decodes_like_the_whole_stream() {
        let text = "λ ❯ git status — 文件 🙂 done";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut stream = Utf8Stream::new();
            let mut out = stream.push(&bytes[..cut]);
            out.push_str(&stream.push(&bytes[cut..]));
            out.push_str(&stream.finish());
            assert_eq!(out, text, "split at byte {cut}");
        }
    }

    #[test]
    fn invalid_bytes_become_replacement_characters_and_decoding_continues() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        // A lead byte followed by something that is not a continuation byte.
        assert_eq!(stream.push(&[0xC3, b'A']), "\u{FFFD}A");
    }

    #[test]
    fn output_matches_lossy_decoding_of_the_whole_stream() {
        let bytes: Vec<u8> = vec![0x68, 0xE2, 0x82, 0xAC, 0xF0, 0x28, 0x8C, 0x28, 0xE2, 0x82, 0x69];
        let expected = String::from_utf8_lossy(&bytes).into_owned();
        for cut in 0..=bytes.len() {
            let mut stream = Utf8Stream::new();
            let mut out = stream.push(&bytes[..cut]);
            out.push_str(&stream.push(&bytes[cut..]));
            out.push_str(&stream.finish());
            assert_eq!(out, expected, "split at byte {cut}");
        }
    }

    #[test]
    fn a_character_cut_off_when_the_stream_ends_is_replaced() {
        let mut stream = Utf8Stream::new();
        assert_eq!(stream.push(&[b'x', 0xE2, 0x82]), "x");
        assert_eq!(stream.finish(), "\u{FFFD}");
        assert_eq!(stream.finish(), "");
    }
}
