import java.io.BufferedInputStream;
import java.io.FileOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * zipalign equivalent: rewrites an APK so that every uncompressed entry starts on a
 * 4-byte boundary (required for resources.arsc on Android 11+ and for mmap'd assets).
 * Run before signing; the v2 signature preserves entry offsets.
 */
public class ZipAlign {
    static final class CountingStream extends FilterOutputStream {
        long count;

        CountingStream(OutputStream out) {
            super(out);
        }

        @Override
        public void write(int b) throws IOException {
            out.write(b);
            count++;
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            out.write(b, off, len);
            count += len;
        }
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 2) {
            System.err.println("usage: ZipAlign <in.apk> <out.apk>");
            System.exit(2);
        }
        ZipFile in = new ZipFile(args[0]);
        CountingStream counter = new CountingStream(new FileOutputStream(args[1]));
        ZipOutputStream out = new ZipOutputStream(counter);
        byte[] buf = new byte[65536];
        int aligned = 0;
        for (Enumeration<? extends ZipEntry> e = in.entries(); e.hasMoreElements(); ) {
            ZipEntry src = e.nextElement();
            ZipEntry dst = new ZipEntry(src.getName());
            dst.setTime(src.getTime());
            if (src.getMethod() == ZipEntry.STORED) {
                dst.setMethod(ZipEntry.STORED);
                dst.setSize(src.getSize());
                dst.setCompressedSize(src.getSize());
                dst.setCrc(src.getCrc());
                int nameLen = src.getName().getBytes(StandardCharsets.UTF_8).length;
                long dataStart = counter.count + 30 + nameLen;
                int pad = (int) ((4 - dataStart % 4) % 4);
                dst.setExtra(pad > 0 ? new byte[pad] : null);
                aligned++;
            } else {
                dst.setMethod(ZipEntry.DEFLATED);
            }
            out.putNextEntry(dst);
            InputStream data = new BufferedInputStream(in.getInputStream(src));
            int n;
            while ((n = data.read(buf)) > 0) out.write(buf, 0, n);
            data.close();
            out.closeEntry();
        }
        out.close();
        in.close();
        System.out.println("aligned " + aligned + " stored entries");
    }
}
