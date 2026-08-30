import { Option, Redacted } from "effect";
import { HttpClientRequest } from "effect/unstable/http";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";
import { GitHubApiError, type GitHubOperation } from "./model.ts";

export const API_ROOT = "https://api.github.com";
export const API_VERSION = "2026-03-10";

export const authorized = (credential: Redacted.Redacted<string>) =>
  HttpClientRequest.setHeaders({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${Redacted.value(credential)}`,
    "user-agent": "usine",
    "x-github-api-version": API_VERSION,
  });

export const transportError = (operation: GitHubOperation, error: HttpClientError) =>
  new GitHubApiError({
    operation,
    status: error.response === undefined ? Option.none() : Option.some(error.response.status),
    message:
      error.response === undefined
        ? "The request to GitHub could not be sent"
        : `GitHub rejected the request with status ${error.response.status}`,
  });
