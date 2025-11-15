/**
 * Unified file system operations with consistent error handling.
 *
 * This module provides a consistent async API for file operations across the application,
 * replacing scattered usage of both sync and async fs methods.
 */

import { readFile, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { wrapError } from './errors.js';

/**
 * Checks if a file or directory exists.
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a directory exists, creating it and any parent directories if needed.
 */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Reads and parses a JSON file.
 *
 * @returns Parsed JSON data, or null if the file doesn't exist or is invalid
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Invalid JSON or other read error
    throw new Error(wrapError(`Failed to read JSON file ${path}`, error));
  }
}

/**
 * Writes data to a JSON file with pretty formatting.
 * Ensures the parent directory exists.
 */
export async function writeJsonFile<T>(path: string, data: T): Promise<void> {
  await ensureDirectory(dirname(path));
  const content = JSON.stringify(data, null, 2) + '\n';
  await writeFile(path, content, 'utf-8');
}

/**
 * Reads a text file.
 *
 * @returns File content as string, or null if the file doesn't exist
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(wrapError(`Failed to read file ${path}`, error));
  }
}

/**
 * Writes content to a text file.
 * Ensures the parent directory exists.
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, content, 'utf-8');
}

/**
 * Lists all files in a directory.
 *
 * @returns Array of filenames, or empty array if directory doesn't exist
 */
export async function listFiles(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(wrapError(`Failed to read directory ${path}`, error));
  }
}
