from __future__ import annotations

import ast
import builtins
import sys
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
SOURCE_DIRS = [PROJECT_DIR / "koc_backend", PROJECT_DIR / "koc_graph"]
BUILTINS = set(dir(builtins))


class FunctionScopeCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.local_names: set[str] = set()
        self.loaded_names: list[tuple[str, int]] = []

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.local_names.add(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.local_names.add(node.name)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.local_names.add(node.name)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self._collect_args(node.args)
        self.visit(node.body)

    def visit_arguments(self, node: ast.arguments) -> None:
        self._collect_args(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.loaded_names.append((node.id, node.lineno))
        elif isinstance(node.ctx, (ast.Store, ast.Del)):
            self.local_names.add(node.id)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.local_names.add(alias.asname or alias.name.split(".", 1)[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name == "*":
                continue
            self.local_names.add(alias.asname or alias.name)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.name:
            self.local_names.add(node.name)
        self.generic_visit(node)

    def _collect_args(self, node: ast.arguments) -> None:
        args = [*node.posonlyargs, *node.args, *node.kwonlyargs]
        if node.vararg:
            args.append(node.vararg)
        if node.kwarg:
            args.append(node.kwarg)
        for arg in args:
            self.local_names.add(arg.arg)


class NestedLoadCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.loaded_names: list[tuple[str, int]] = []

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        collector = FunctionScopeCollector()
        collector.visit(node)
        self.loaded_names.extend(collector.loaded_names)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        collector = FunctionScopeCollector()
        collector.visit(node)
        self.loaded_names.extend(collector.loaded_names)


def collect_module_names(tree: ast.Module) -> set[str]:
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".", 1)[0])
        elif isinstance(node, ast.ImportFrom):
            if any(alias.name == "*" for alias in node.names):
                continue
            for alias in node.names:
                names.add(alias.asname or alias.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            for target in assignment_targets(node):
                names.update(target_names(target))
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.With, ast.AsyncWith, ast.Try)):
            collector = FunctionScopeCollector()
            collector.visit(node)
            names.update(collector.local_names)
    return names


def assignment_targets(node: ast.AST) -> list[ast.AST]:
    if isinstance(node, ast.Assign):
        return list(node.targets)
    if isinstance(node, ast.AnnAssign):
        return [node.target]
    if isinstance(node, ast.AugAssign):
        return [node.target]
    return []


def target_names(node: ast.AST) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, (ast.Tuple, ast.List)):
        names: set[str] = set()
        for item in node.elts:
            names.update(target_names(item))
        return names
    return set()


def function_defined_names(node: ast.AST) -> set[str]:
    collector = FunctionScopeCollector()
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        collector._collect_args(node.args)
        for decorator in node.decorator_list:
            collector.visit(decorator)
        if node.returns:
            collector.visit(node.returns)
        for statement in node.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                collector.local_names.add(statement.name)
                continue
            collector.visit(statement)
    return collector.local_names


def function_loads(node: ast.AST) -> list[tuple[str, int]]:
    collector = NestedLoadCollector()
    collector.visit(node)
    return collector.loaded_names


def check_file(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    module_names = collect_module_names(tree)
    errors: list[str] = []

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        local_names = function_defined_names(node)
        known = module_names | local_names | BUILTINS
        for name, line in function_loads(node):
            if name.startswith("__"):
                continue
            if name not in known:
                rel = path.relative_to(PROJECT_DIR)
                errors.append(f"{rel}:{line}: possibly undefined name '{name}' in {node.name}()")
    return errors


def main() -> None:
    errors: list[str] = []
    for source_dir in SOURCE_DIRS:
        for path in source_dir.rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            errors.extend(check_file(path))
    if errors:
        print("Static name check failed:")
        for error in errors:
            print(error)
        raise SystemExit(1)
    print("Static name check passed.")


if __name__ == "__main__":
    sys.path.insert(0, str(PROJECT_DIR))
    main()
