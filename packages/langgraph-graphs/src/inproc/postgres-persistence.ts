// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Host-owned lifetime; this helper accepts a connection string and never reads env or runs setup. */
import pg from "pg";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";

export async function createMemoryPersistence() {
  return {
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
    async close() {},
  };
}

export async function createPostgresPersistence(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const checkpointer = new PostgresSaver(pool, undefined, {
    schema: "cogni_agent_runtime",
  });
  const store = new PostgresStore({
    connectionOptions: { connectionString, max: 1 },
    schema: "cogni_agent_runtime",
    ensureTables: false,
  });
  try {
    await store.start();
  } catch (error) {
    await Promise.allSettled([store.stop(), checkpointer.end()]);
    throw error;
  }
  return {
    checkpointer,
    store,
    async close() {
      await Promise.all([store.stop(), checkpointer.end()]);
    },
  };
}
