package io.vaultdatum.server.sync;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public final class ContentHash {

    private ContentHash() {
    }

    public static HashedContent copy(Path source, Path destination) throws IOException {
        MessageDigest digest = newDigest();
        long size = 0;

        try (InputStream input = Files.newInputStream(source);
                FileChannel output = FileChannel.open(destination, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                        StandardOpenOption.TRUNCATE_EXISTING)) {
            byte[] buffer = new byte[8192];
            int count;

            while ((count = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, count);
                writeFully(output, buffer, count);
                size += count;
            }
            output.force(true);
        }

        return new HashedContent(encode(digest.digest()), size);
    }

    public static HashedContent calculate(Path content) throws IOException {
        MessageDigest digest = newDigest();
        long size = 0;

        try (InputStream input = Files.newInputStream(content)) {
            byte[] buffer = new byte[8192];
            int count;

            while ((count = input.read(buffer)) >= 0) {
                digest.update(buffer, 0, count);
                size += count;
            }
        }

        return new HashedContent(encode(digest.digest()), size);
    }

    public static boolean isValid(String value) {
        return value != null && value.matches("sha256:[0-9a-f]{64}");
    }

    public static String calculateUtf8(String value) {
        return calculate(value.getBytes(StandardCharsets.UTF_8));
    }

    public static String calculate(byte[] value) {
        MessageDigest digest = newDigest();
        return encode(digest.digest(value));
    }

    private static MessageDigest newDigest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is not available", exception);
        }
    }

    private static void writeFully(FileChannel output, byte[] buffer, int count) throws IOException {
        ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, count);

        while (bytes.hasRemaining()) {
            output.write(bytes);
        }
    }

    private static String encode(byte[] digest) {
        StringBuilder value = new StringBuilder("sha256:");

        for (byte current : digest) {
            value.append(String.format("%02x", current));
        }

        return value.toString();
    }

    public record HashedContent(String value, long size) {
    }
}
