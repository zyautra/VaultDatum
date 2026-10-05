package io.vaultdatum.server.sync;

import jakarta.annotation.PreDestroy;
import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import org.jboss.logging.Logger;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Refreshes the server Backup at a fixed interval measured from the current Backup.
 *
 * <p>A failed or skipped refresh never affects synchronization; it is logged
 * and retried after the next interval.</p>
 */
@ApplicationScoped
public final class ServerBackupScheduler {

    private static final Logger LOG = Logger.getLogger(ServerBackupScheduler.class);

    private static final Duration MINIMUM_DELAY = Duration.ofMinutes(1);

    private final ServerBackup serverBackup;

    private final Duration interval;

    private ScheduledExecutorService executor;

    public ServerBackupScheduler(
            ServerBackup serverBackup,
            @ConfigProperty(name = "vaultdatum.backup.interval-hours", defaultValue = "24") long intervalHours) {
        if (intervalHours < 0) {
            throw new IllegalArgumentException("vaultdatum.backup.interval-hours must not be negative");
        }
        this.serverBackup = serverBackup;
        this.interval = Duration.ofHours(intervalHours);
    }

    public synchronized void start() {
        if (interval.isZero() || executor != null) {
            return;
        }

        executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "vaultdatum-backup");
            thread.setDaemon(true);
            return thread;
        });
        schedule(firstDelay());
    }

    @PreDestroy
    synchronized void stop() {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    private Duration firstDelay() {
        try {
            BackupManifest current = serverBackup.current();
            if (current == null) {
                return MINIMUM_DELAY;
            }
            Duration remaining = Duration.between(Instant.now(), Instant.parse(current.createdAt()).plus(interval));
            return remaining.compareTo(MINIMUM_DELAY) < 0 ? MINIMUM_DELAY : remaining;
        } catch (RuntimeException exception) {
            LOG.warnf("backup_schedule_unreadable cause=%s", exception.getClass().getSimpleName());
            return MINIMUM_DELAY;
        }
    }

    private synchronized void schedule(Duration delay) {
        if (executor != null) {
            executor.schedule(this::run, delay.toMillis(), TimeUnit.MILLISECONDS);
        }
    }

    private void run() {
        try {
            serverBackup.refresh(BackupTrigger.SCHEDULED);
        } catch (RuntimeException exception) {
            LOG.warnf("backup_scheduled_refresh_failed cause=%s", exception.getClass().getSimpleName());
        } finally {
            schedule(interval);
        }
    }
}
