package io.vaultdatum.server.sync;

public sealed interface CreateBase permits DeletedCreateBase, UnknownCreateBase {
}
