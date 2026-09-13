package io.vaultdatum.server.sync;

/**
 * Serializes filesystem and database mutations within this server process.
 *
 * <p>A synchronization operation has a short interval in which its durable
 * intent and Vault filesystem state are coordinated. CREATE, MODIFY, and
 * DELETE must share one lock during that interval so they cannot observe the
 * same base revision or interfere with each other's recovery files.</p>
 */
final class MutationLock {

    static final Object INSTANCE = new Object();

    private MutationLock() {
    }
}
