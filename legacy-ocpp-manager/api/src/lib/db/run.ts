import { Umzug } from "umzug";
import path from "path";
import fs from "fs";
import { sql } from "kysely";
import { db } from "./db";
import { logger } from "../globals/logger";

function ensureDirSync(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.info(`📁 Directory created: ${dirPath}`);
  }
}

const MIGRATIONS_DIR = "./src/lib/db/migrations";
ensureDirSync(MIGRATIONS_DIR);

async function runQueryWithTransaction(sqlQuery: string) {
  try {
    await db.transaction().execute(async (trx) => {
      await sql.raw(sqlQuery).execute(trx);
    });
    logger.info("✅ Query executed successfully");
  } catch (error: any) {
    await sql.raw("ROLLBACK").execute(db);
    logger.error(`❌ Query error: ${error.message}`);
    throw error;
  }
}

class PostgresStorage {
  async logMigration(migration: { name: string }) {
    const migrationName = migration.name.toLowerCase();
    try {
      await sql`INSERT INTO migration (name) VALUES (${migrationName})`.execute(
        db
      );
      logger.info(`✅ Logged migration: ${migrationName}`);
    } catch (error: any) {
      logger.error(`❌ Error logging migration: ${error.message}`);
      throw error;
    }
  }

  async unlogMigration(migration: { name: string }) {
    const migrationName = migration.name.toLowerCase();
    try {
      await sql`DELETE FROM migration WHERE name = ${migrationName}`.execute(
        db
      );
      logger.info(`✅ Unlogged migration: ${migrationName}`);
    } catch (error: any) {
      logger.error(`❌ Error removing migration log: ${error.message}`);
      throw error;
    }
  }

  async executed(): Promise<string[]> {
    try {
      const { rows } = await sql`SELECT name FROM migration`.execute(db);

      const executedMigrations = rows.map((row: any) => row.name);
      logger.info(
        `✅ Retrieved executed migrations: ${executedMigrations.join(", ")}`
      );
      return executedMigrations;
    } catch (error: any) {
      logger.error(`❌ Error retrieving executed migrations: ${error.message}`);
      return [];
    }
  }
}

async function setupMigrations() {
  logger.info("⏳ Setting up migration table...");
  await runQueryWithTransaction(`
    CREATE TABLE IF NOT EXISTS migration (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  logger.info(`📂 Searching for migrations in: ${MIGRATIONS_DIR}`);

  const umzug = new Umzug({
    migrations: {
      glob: path.join(MIGRATIONS_DIR, "*.sql"),
      resolve: ({ name, path: filePath }) => ({
        name,
        path: filePath,
        up: async () => {
          const sqlQuery = fs.readFileSync(filePath!, "utf8");
          try {
            logger.info(`🔄 Applying migration: ${name}`);
            await runQueryWithTransaction(sqlQuery);
            logger.info(`✅ Migration ${name} applied successfully.`);
          } catch (error: any) {
            logger.error(`❌ Migration ${name} failed: ${error.message}`);
            throw error;
          }
        },
      }),
    },
    context: db,
    storage: new PostgresStorage(),
    logger: {
      debug: logger.debug.bind(logger),
      info: logger.info.bind(logger),
      warn: logger.warn.bind(logger),
      error: logger.error.bind(logger),
    },
  });

  async function runMigrations() {
    try {
      logger.info("⏳ Running migrations...");
      const start = Date.now();

      const migrations = await umzug.up();

      if (migrations.length > 0) {
        logger.info("✅ Applied migrations:");
        migrations.forEach((m) => {
          logger.info(`  - Name: ${m.name}, Path: ${m.path}`);
        });
      } else {
        logger.info("✅ No migrations to apply.");
      }

      const duration = Date.now() - start;
      logger.info(`✅ Migrations complete in ${duration}ms.`);
      await db.destroy();
    } catch (error: any) {
      logger.error(`❌ Migration failed: ${error.message}`);
    }
  }

  await runMigrations();
}

setupMigrations().catch((err) => {
  logger.error(`❌ Error setting up migrations: ${err.message}`);
  process.exit(1);
});
