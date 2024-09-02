import { parseAsync, transformFromAstAsync, NodePath } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { Identifier, isValidIdentifier, Node } from "@babel/types";
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';

const traverse: typeof babelTraverse.default.default = (
  typeof babelTraverse.default === "function"
    ? babelTraverse.default
    : babelTraverse.default.default
) as any;

const CONTEXT_WINDOW_SIZE = 200;
const BATCH_SIZE = 1000;

type Visitor = (name: string, scope: string) => Promise<string>;

export async function visitAllIdentifiers(
  code: string,
  visitor: Visitor,
  onProgress?: (percentageDone: number) => void
) {
  const ast = await parseAsync(code);
  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const visited = new Map<string, string>();
  const identifiers: NodePath<Identifier>[] = [];

  // Collect all identifiers in a single pass
  traverse(ast, {
    BindingIdentifier(path) {
      identifiers.push(path);
    }
  }, undefined, { noScope: true });

  const numRenamesExpected = identifiers.length;
  const numCPUs = os.cpus().length;
  const batchSize = Math.min(BATCH_SIZE, Math.ceil(numRenamesExpected / numCPUs));

  for (let i = 0; i < identifiers.length; i += batchSize) {
    const batch = identifiers.slice(i, i + batchSize);
    await processBatch(batch, visitor, visited);
    onProgress?.((i + batch.length) / numRenamesExpected);
  }

  const stringified = await transformFromAstAsync(ast);
  if (!stringified?.code) {
    throw new Error("Failed to stringify code");
  }
  return stringified.code;
}

async function processBatch(
  batch: NodePath<Identifier>[],
  visitor: Visitor,
  visited: Map<string, string>
) {
  const tasks = batch.map(async (path) => {
    if (visited.has(path.node.name)) return;

    const surroundingCode = await scopeToString(path);
    const renamed = await visitor(path.node.name, surroundingCode);

    let safeRenamed = isValidIdentifier(renamed) ? renamed : `_${renamed}`;
    while (visited.has(safeRenamed)) {
      safeRenamed = `_${safeRenamed}`;
    }

    visited.set(path.node.name, safeRenamed);
    path.scope.rename(path.node.name, safeRenamed);
  });

  await Promise.all(tasks);
}

// ... (rest of the code remains the same)

function hasVisited(path: NodePath<Identifier>, visited: Set<string>) {
  return visited.has(path.node.name);
}

function markVisited(
  path: NodePath<Identifier>,
  newName: string,
  visited: Set<string>
) {
  visited.add(newName);
}

async function scopeToString(path: NodePath<Identifier>) {
  const surroundingPath = closestSurroundingContextPath(path);
  const code = `${surroundingPath}`; // Implements a hidden `.toString()`
  if (code.length < CONTEXT_WINDOW_SIZE) {
    return code;
  }
  if (surroundingPath.isProgram()) {
    const start = path.node.start ?? 0;
    const end = path.node.end ?? code.length;
    if (end < CONTEXT_WINDOW_SIZE / 2) {
      return code.slice(0, CONTEXT_WINDOW_SIZE);
    }
    if (start > code.length - CONTEXT_WINDOW_SIZE / 2) {
      return code.slice(-CONTEXT_WINDOW_SIZE);
    }

    return code.slice(
      start - CONTEXT_WINDOW_SIZE / 2,
      end + CONTEXT_WINDOW_SIZE / 2
    );
  } else {
    return code.slice(0, CONTEXT_WINDOW_SIZE);
  }
}

function closestSurroundingContextPath(
  path: NodePath<Identifier>
): NodePath<Node> {
  const programOrBindingNode = path.findParent(
    (p) => p.isProgram() || path.node.name in p.getOuterBindingIdentifiers()
  )?.scope.path;
  return programOrBindingNode ?? path.scope.path;
}


