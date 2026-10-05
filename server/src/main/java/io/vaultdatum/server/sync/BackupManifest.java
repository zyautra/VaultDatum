package io.vaultdatum.server.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * The {@code backup.json} description of a server Backup.
 */
public record BackupManifest(
        String vaultId,
        long revision,
        String createdAt,
        BackupTrigger trigger,
        String serverVersion,
        String schemaVersion,
        long files,
        long bytes,
        String syncDbHash) {

    static final String FILE_NAME = "backup.json";

    private static final int FORMAT = 1;

    private static final ObjectMapper JSON = new ObjectMapper();

    static BackupManifest read(Path backup) throws IOException {
        JsonNode node = JSON.readTree(backup.resolve(FILE_NAME).toFile());

        if (node == null || node.path("format").asInt(-1) != FORMAT) {
            throw new IOException("Unsupported backup format");
        }
        return new BackupManifest(
                requiredText(node, "vaultId"),
                node.path("revision").asLong(-1),
                requiredText(node, "createdAt"),
                BackupTrigger.valueOf(requiredText(node, "trigger")),
                node.path("serverVersion").asText(""),
                requiredText(node, "schemaVersion"),
                node.path("files").asLong(-1),
                node.path("bytes").asLong(-1),
                requiredText(node, "syncDbHash"));
    }

    void write(Path backup) throws IOException {
        ObjectNode node = JSON.createObjectNode()
                .put("format", FORMAT)
                .put("vaultId", vaultId)
                .put("revision", revision)
                .put("createdAt", createdAt)
                .put("trigger", trigger.name())
                .put("serverVersion", serverVersion)
                .put("schemaVersion", schemaVersion)
                .put("files", files)
                .put("bytes", bytes)
                .put("syncDbHash", syncDbHash);
        Path file = backup.resolve(FILE_NAME);

        Files.write(file, JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(node));
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.WRITE)) {
            channel.force(true);
        }
    }

    private static String requiredText(JsonNode node, String field) throws IOException {
        JsonNode value = node.get(field);

        if (value == null || !value.isTextual() || value.asText().isBlank()) {
            throw new IOException("Backup description is missing " + field);
        }
        return value.asText();
    }
}
