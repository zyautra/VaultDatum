package io.vaultdatum.server.sync;

import static io.vaultdatum.server.jooq.Tables.CHANGE_JOURNAL;
import static io.vaultdatum.server.jooq.Tables.OPERATIONS;
import static io.vaultdatum.server.jooq.Tables.PATH_STATE;
import static io.vaultdatum.server.jooq.Tables.VAULT_METADATA;

import io.vaultdatum.server.config.ContentLimits;
import io.vaultdatum.server.config.DataDirectories;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Imports files copied into a new server Vault as the initial journal.
 *
 * <p>This is the only path that turns Vault filesystem state into changes. It
 * runs only when explicitly requested and only against an empty journal. Every
 * entry must pass the preflight before anything is recorded, and the whole
 * import commits in one transaction, so a failed import leaves no state behind.
 * The Vault filesystem is never modified.</p>
 */
@ApplicationScoped
public final class InitialVaultImport {

    private static final Logger LOG = Logger.getLogger(InitialVaultImport.class);

    private final DataDirectories dataDirectories;

    private final DSLContext dsl;

    private final ContentLimits contentLimits;

    private final boolean requested;

    public InitialVaultImport(
            DataDirectories dataDirectories,
            DSLContext dsl,
            ContentLimits contentLimits,
            @ConfigProperty(name = "vaultdatum.initial-import", defaultValue = "false") boolean requested) {
        this.dataDirectories = dataDirectories;
        this.dsl = dsl;
        this.contentLimits = contentLimits;
        this.requested = requested;
    }

    public void runIfRequested() {
        if (requested) {
            run();
        }
    }

    public long run() {
        synchronized (MutationLock.INSTANCE) {
            requireEmptySyncState();
            Preflight preflight = preflight(dataDirectories.vault(), contentLimits.maximumContentBytes());

            if (preflight.entries().isEmpty() && preflight.problems().isEmpty()) {
                throw new InitialVaultImportException(
                        "The Vault directory is empty; check the data volume before requesting an initial import");
            }
            if (!preflight.problems().isEmpty()) {
                for (Problem problem : preflight.problems()) {
                    LOG.errorf("initial_import_rejected path=%s reason=%s", problem.path(), problem.reason());
                }
                throw new InitialVaultImportException(
                        preflight.problems().size() + " Vault entries cannot be imported; nothing was recorded");
            }

            List<ImportedEntry> entries = hashEntries(preflight.entries());
            long revision = commit(entries);
            LOG.infof("initial_import_complete changes=%d revision=%d", entries.size(), revision);
            return revision;
        }
    }

    private void requireEmptySyncState() {
        long revision = dsl.select(VAULT_METADATA.CURRENT_REVISION)
                .from(VAULT_METADATA)
                .where(VAULT_METADATA.ID.eq(1))
                .fetchSingle(VAULT_METADATA.CURRENT_REVISION);
        boolean recorded = dsl.fetchExists(PATH_STATE)
                || dsl.fetchExists(OPERATIONS)
                || dsl.fetchExists(CHANGE_JOURNAL);

        if (revision != 0 || recorded) {
            throw new InitialVaultImportException(
                    "An initial import requires an empty journal; unset VAULTDATUM_INITIAL_IMPORT for this Vault");
        }
    }

    /**
     * Lists importable Vault entries and every entry that blocks the import.
     *
     * <p>Regular files and empty directories are importable. Directories that
     * contain files are implicit parents. Symbolic links are never followed.</p>
     */
    static Preflight preflight(Path vault, long maximumContentBytes) {
        List<Entry> entries = new ArrayList<>();
        List<Problem> problems = new ArrayList<>();

        try {
            Files.walkFileTree(vault, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) {
                    if (directory.equals(vault)) {
                        return FileVisitResult.CONTINUE;
                    }
                    String path = VaultFiles.relativePath(vault, directory);
                    String problem = pathProblem(directory, path);
                    if (problem != null) {
                        problems.add(new Problem(path, problem));
                        return FileVisitResult.SKIP_SUBTREE;
                    }
                    if (isEmptyDirectory(directory)) {
                        entries.add(new Entry(path, EntryType.DIRECTORY));
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) {
                    String path = VaultFiles.relativePath(vault, file);
                    String problem = pathProblem(file, path);
                    if (problem == null && !attributes.isRegularFile()) {
                        problem = "not a regular file";
                    }
                    if (problem == null && attributes.size() > maximumContentBytes) {
                        problem = "exceeds the maximum content size";
                    }
                    if (problem == null) {
                        entries.add(new Entry(path, EntryType.FILE));
                    } else {
                        problems.add(new Problem(path, problem));
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException exception) {
                    problems.add(new Problem(VaultFiles.relativePath(vault, file), "unreadable"));
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException exception) {
            throw new InitialVaultImportException("Could not scan the Vault for an initial import", exception);
        }

        entries.sort((left, right) -> left.path().compareTo(right.path()));
        problems.sort((left, right) -> left.path().compareTo(right.path()));
        return new Preflight(List.copyOf(entries), List.copyOf(problems));
    }

    private List<ImportedEntry> hashEntries(List<Entry> entries) {
        List<ImportedEntry> imported = new ArrayList<>(entries.size());

        for (Entry entry : entries) {
            if (entry.type() == EntryType.DIRECTORY) {
                imported.add(new ImportedEntry(entry, null));
                continue;
            }
            Path file = SyncPath.parse(entry.path()).resolveUnder(dataDirectories.vault());
            try {
                BasicFileAttributes before = Files.readAttributes(
                        file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                ContentHash.HashedContent content = ContentHash.calculate(file);
                BasicFileAttributes after = Files.readAttributes(
                        file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!after.isRegularFile() || before.size() != after.size() || after.size() != content.size()
                        || !before.lastModifiedTime().equals(after.lastModifiedTime())) {
                    throw new InitialVaultImportException(
                            "Vault file changed during the initial import; nothing was recorded: " + entry.path());
                }
                imported.add(new ImportedEntry(entry, content));
            } catch (IOException exception) {
                throw new InitialVaultImportException(
                        "Could not read Vault file during the initial import: " + entry.path(), exception);
            }
        }

        return imported;
    }

    private long commit(List<ImportedEntry> entries) {
        return dsl.transactionResult(configuration -> {
            DSLContext transaction = DSL.using(configuration);
            long revision = 0;

            for (ImportedEntry imported : entries) {
                revision = ChangeJournal.nextRevision(transaction);
                String path = imported.entry().path();
                ChangeJournal.appendServerExternalChange(transaction, revision, "IMPORT-" + UUID.randomUUID(), "CREATE");

                if (imported.content() == null) {
                    transaction.insertInto(PATH_STATE)
                            .columns(PATH_STATE.PATH, PATH_STATE.ENTRY_TYPE, PATH_STATE.STATE, PATH_STATE.LATEST_REVISION)
                            .values(path, "DIRECTORY", "PRESENT", revision)
                            .execute();
                    ChangeJournal.appendPresentDirectory(transaction, revision, 0, path);
                } else {
                    transaction.insertInto(PATH_STATE)
                            .columns(
                                    PATH_STATE.PATH,
                                    PATH_STATE.ENTRY_TYPE,
                                    PATH_STATE.STATE,
                                    PATH_STATE.LATEST_REVISION,
                                    PATH_STATE.CONTENT_HASH,
                                    PATH_STATE.SIZE)
                            .values(path, "FILE", "PRESENT", revision, imported.content().value(), imported.content().size())
                            .execute();
                    ChangeJournal.appendPresentFile(
                            transaction, revision, 0, path, imported.content().value(), imported.content().size());
                }
            }
            return revision;
        });
    }

    private static boolean isEmptyDirectory(Path directory) {
        try {
            return VaultFiles.isEmptyDirectory(directory);
        } catch (IOException exception) {
            return false;
        }
    }

    private static String pathProblem(Path entry, String path) {
        if (entry.getFileName().toString().startsWith(".")) {
            return "hidden entry";
        }
        try {
            SyncPath.parse(path);
            return null;
        } catch (IllegalArgumentException exception) {
            return "invalid sync path";
        }
    }

    enum EntryType {
        FILE,
        DIRECTORY
    }

    record Entry(String path, EntryType type) {
    }

    record Problem(String path, String reason) {
    }

    record Preflight(List<Entry> entries, List<Problem> problems) {
    }

    private record ImportedEntry(Entry entry, ContentHash.HashedContent content) {
    }
}
