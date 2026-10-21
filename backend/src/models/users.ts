import type { Pool, QueryResultRow } from "pg";

import { AuthStorageError, DuplicateEmailError } from "../errors/auth";

/* our 'core' data structures here */
export interface User {
  id: number;
  name: string;
  email: string;
}

interface StoredUser extends User {
  password_hash: string;
}

/* we take a pool to manage manage reusablec connections */
export function createUserRepository(pool: Pool) {
  async function query<Row extends QueryResultRow>(
    sql: string,
    values: unknown[] /* allows us to enter different types ie, number or string - see application in create() */,
  ): Promise<Row[]> {
    /* ^^ our return type should an array of row (type QueryResultRow)
    - wrapped in a promise since this is async */

    try {
      // run agains the db
      const result = await pool.query<Row>(sql, values);
      return result.rows;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" /* unique constraint violation */ &&
        "constraint" in error &&
        error.constraint ===
          "users_email_key" /* is this the violated constraint ?  */
      ) {
        throw new DuplicateEmailError(
          "An account with this email already exists",
        );
      }

      throw new AuthStorageError("Authentication storage is unavailable.");
    }
  }

  /* simple jdbc-prepared-statement style queries */
  return {
    async create(
      name: string,
      email: string,
      passwordHash: string,
    ): Promise<User> {
      /* coerce all the query to the type user - like List<User> in java */
      const rows = await query<User>(
        `INSERT INTO app_private.users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, email`,
        [name, email, passwordHash],
      );

      return rows[0];
    },

    async findByEmail(email: string): Promise<StoredUser | undefined> {
      const rows = await query<StoredUser>(
        "SELECT id, name, email, password_hash FROM app_private.users WHERE email = $1",
        [email],
      );
      return rows[0];
    },

    async findById(id: number): Promise<User | undefined> {
      const rows = await query<User>(
        "SELECT id, name, email FROM app_private.users WHERE id = $1",
        [id],
      );
      return rows[0];
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
