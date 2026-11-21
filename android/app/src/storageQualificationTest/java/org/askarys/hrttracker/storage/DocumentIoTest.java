package org.askarys.hrttracker.storage;

import static org.junit.Assert.*;
import java.io.*;
import org.askarys.hrttracker.files.DocumentIo;
import org.junit.Test;

public final class DocumentIoTest {
    @Test public void exactLimitAndBinaryBytes() throws Exception {
        byte[] bytes = new byte[DocumentIo.MAX_BYTES]; bytes[0] = (byte)255; bytes[bytes.length - 1] = (byte)128;
        assertArrayEquals(bytes, DocumentIo.readBounded(new ByteArrayInputStream(bytes)));
    }
    @Test public void oversizedUnknownStreamClosesAndRejects() throws Exception {
        final boolean[] closed = { false };
        InputStream input = new ByteArrayInputStream(new byte[DocumentIo.MAX_BYTES + 1]) {
            @Override public void close() { closed[0] = true; }
        };
        try { DocumentIo.readBounded(input); fail(); } catch (DocumentIo.TooLarge expected) {}
        assertTrue(closed[0]);
    }
    @Test public void saveRequiresSuccessfulClose() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream() {
            @Override public void close() throws IOException { throw new IOException("synthetic close failure"); }
        };
        try { DocumentIo.writeAndClose(output, new byte[]{0, (byte)255}); fail(); } catch (IOException expected) {}
        assertArrayEquals(new byte[]{0, (byte)255}, output.toByteArray());
    }
    @Test public void writeFailureStillCloses() throws Exception {
        final boolean[] closed = { false };
        OutputStream output = new OutputStream() {
            @Override public void write(int value) throws IOException { throw new IOException("synthetic failure"); }
            @Override public void close() { closed[0] = true; }
        };
        try { DocumentIo.writeAndClose(output, new byte[]{1}); fail(); } catch (IOException expected) {}
        assertTrue(closed[0]);
    }
}
