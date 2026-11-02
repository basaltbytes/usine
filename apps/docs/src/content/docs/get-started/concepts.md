---
title: Concepts
description: The instance, projects, loops, agents, runs, attempts, and workers you use in usine.
---

An instance stores your configuration and run history. Its projects group repositories; each project's loops select work for agents. The diagram separates the configuration you set up from the execution of a matching issue or pull request.

```mermaid
---
config:
  flowchart:
    nodeSpacing: 20
    rankSpacing: 24
    padding: 8
---
flowchart TB
  accTitle: Configuration and execution
  accDescr: An instance contains projects, agents, and workers. A project contains managed repositories and loops. A loop uses an agent. An issue or pull request matching the loop's trigger starts a run with one or more attempts. Each attempt runs the loop's agent on a worker.

  subgraph configuration[Configuration]
    subgraph instance[Instance]
      subgraph project[Project]
        repos[Managed repositories]
        loop[Loop]
      end
      agent[Agent]
      worker[Worker]
      loop -. uses .-> agent
    end
  end

  subgraph execution[Execution]
    direction TB
    item["Issue or<br/>pull request"] -->|matches trigger| run[Run]
    run -->|1+ tries| attempt[Attempt]
    attempt -->|runs| usedAgent["Loop's agent"]
    attempt -->|runs on| usedWorker[Worker]
  end

  configuration ~~~ execution
```

## Instance

An instance is one installation of usine with its own configuration, credentials, and runtime state, served by an orchestrator. It contains projects, agents, and workers. Its instance folder contains `.usine/`; an instance repo is a Git repository for bootstrap and configuration import and export files. [Start an instance in the quickstart](/get-started/quickstart/).

## Project

A project is a named group of managed repositories with one board and the loops that run on them. The registry lists managed repositories, and a repository belongs to at most one project. [Operate a project's board](/guides/move-a-task/).

## Loop

A loop belongs to a project and defines a trigger and the agent run to start for each matching item in that project's repositories. It references one agent from the instance. An item is a GitHub issue or pull request; a trigger can select issues, pull requests, or schedule ticks. [Write a loop](/guides/write-a-loop/).

## Agent

An agent is an instance-level definition of standing instructions and a brain spec: its harness, model, and reasoning effort. Multiple loops can reference the same agent. The harness is the coding-agent CLI, such as Claude Code, Codex, or Pi. [Write an agent](/guides/write-an-agent/).

## Run

A run is the work for one event of a loop, such as an issue or pull request matching its trigger. A run has one or more attempts when execution starts, one per try. In the UI, a run can wait for approval, queue for a worker, run an attempt, or wait for CI before it closes as succeeded, failed, or canceled. [Approve and follow a run](/guides/follow-a-run/).

## Attempt

An attempt is one try of a run's step, running the loop's agent on a worker. Retrying a failed run creates another attempt in the same run, with its own transcript of session messages. [Retry an attempt](/guides/retry-a-run/).

## Worker

A worker is an instance-level machine configuration for running an attempt's child sessions in a checkout. The default local worker uses the machine and user running `usine up`; the Pi parent session always runs in the orchestrator. [Add a worker](/guides/add-a-worker/) to run children on another machine.

## Board and task

A board groups a project's tasks into lanes. A task groups linked issues and pull requests with their runs; its current item is the issue or pull request shown on the board. A lane maps to GitHub labels or item states, and moving a card changes labels on GitHub. [Use the board](/guides/follow-a-run/).

## Configuration revision

A revision records a configuration change with its number, actor, time, optional message, and before-and-after values. Later starts read stored configuration; editing the original bootstrap files has no effect until you import them. [Change the configuration](/guides/change-the-configuration/).
