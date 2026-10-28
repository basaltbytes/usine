import type { RepositoryName } from "@usine/core/repository";

export const taskNotFound = "Task not found";
export const taskNotFoundDescription = (repository: RepositoryName, number: string): string =>
  `#${number} is not among the newest items on the ${repository} board`;
export const backToBoard = "Back to the board";
