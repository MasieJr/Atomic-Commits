import bcrypt from "bcrypt";
import type { RequestHandler } from "express";

import type { UserRepository } from "../models/users";
import { DuplicateEmailError } from "../errors/auth";
import type { AccessTokenService } from "../services/tokens";

/* Precomputed at registration's cost so missing users still incur bcrypt work. */
const dummyPasswordHash =
  "$2b$12$Ok44cctT7ytcTIK7YDrAoeywTPKihwrWuiToIlsE4SaKNhO9IOyl6";

/* do a basic shape check else return json */
function requestBody(body: unknown): Record<string, unknown> {
  /* record = kind of a json, a map like object keyed by string with unkown vals */
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return {};
  return body as Record<string, unknown>;
}

export function createAuthController(
  users: UserRepository,
  tokens: AccessTokenService,
) {
  const register: RequestHandler = async (req, res) => {
    const { name, email, password } = requestBody(
      req.body,
    ); /* aforementioned validation of body */

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      res
        .status(400)
        .json({ error: "Please provide your name, email and password" });
      return;
    }
    /* remove front and back whitespace and perform val - self explanatory for the most part */
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    const nameLength = Array.from(cleanName).length;
    if (nameLength < 2 || nameLength > 80) {
      res
        .status(400)
        .json({ error: "Name must be between 2 and 80 characters" });
      return;
    }

    if (
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      res.status(400).json({ error: "Enter a valid email address" });
      return;
    }

    /* maybe come back and add more checks since this is banking after all */
    // TODO : bolster password checks
    /* bcrypt ignores bytes after the first 72; UTF-8 characters can use multiple bytes. */
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      res.status(400).json({
        error: "Password must be at least 8 characters and no more than 72 bytes",
      });
      return;
    }

    /* Store a salted hash instead of the password; 12 is bcrypt's work factor. */
    const passwordHash = await bcrypt.hash(password, 12);
    let user;

    try {
      user = await users.create(cleanName, cleanEmail, passwordHash);
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        res
          .status(409)
          .json({ error: "An account with this email already exists" });
        return;
      }
      throw error;
    }

    /* if we made it through all those catch blocks, we can let the user know we created the account */
    /* sign them a fresh bearer token right away so registering logs you in */
    res.status(201).json({
      message: "Account created successfully",
      user,
      token: tokens.sign(user.id),
    });
  };

  /* we follow the same patterns as the well documented ones above these */
  const login: RequestHandler = async (req, res) => {
    const { email, password } = requestBody(req.body);

    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Please enter your email and password" });
      return;
    }

    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const user = await users.findByEmail(email.trim().toLowerCase());
    const passwordMatches = await bcrypt.compare(
      password,
      user?.password_hash ?? dummyPasswordHash,
    );

    if (!user || !passwordMatches) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    /* sign the access token instead of creating a server-side session */
    res.json({
      message: "Login successful",
      user: { id: user.id, name: user.name, email: user.email },
      token: tokens.sign(user.id),
    });
  };

  /* gimme current user, resolved from the verified bearer token */
  const me: RequestHandler = async (req, res) => {
    const user = await users.findById(req.userId!);

    if (!user) {
      res.status(401).json({ error: "Account not found" });
      return;
    }

    res.json({ user });
  };

  /* jwt logout is client side - throw the token away, we have no server side
  session to destroy until a token revocation mechanism exists */
  const logout: RequestHandler = (_req, res) => {
    res.json({ message: "Logged out successfully" });
  };

  return { register, login, me, logout };
}

export type AuthController = ReturnType<typeof createAuthController>;
