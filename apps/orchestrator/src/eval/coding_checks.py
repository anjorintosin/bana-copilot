"""Run a model-written stdin/stdout solution against brute force on random small cases.

Usage: python3 coding_checks.py <case_id> <solution.py>
Prints one JSON line: {"ok": bool, "detail": str}
"""
import itertools
import json
import random
import subprocess
import sys

MOD = 10**9 + 7


def tree_pairs():
    def brute(n, k, edges):
        g = [[] for _ in range(n + 1)]
        for u, v, w in edges:
            g[u].append((v, w))
            g[v].append((u, w))
        total = 0
        for s in range(1, n + 1):
            dist = {s: 0}
            stack = [s]
            while stack:
                u = stack.pop()
                for v, w in g[u]:
                    if v not in dist:
                        dist[v] = dist[u] + w
                        stack.append(v)
            total += sum(1 for t, d in dist.items() if t > s and d <= k)
        return total

    def gen(rng):
        n = rng.randint(1, 25)
        edges = [(i, rng.randint(1, i - 1), rng.randint(1, 9)) for i in range(2, n + 1)]
        k = rng.randint(0, 40)
        text = f"{n} {k}\n" + "".join(f"{u} {v} {w}\n" for u, v, w in edges)
        return text, brute(n, k, edges)

    example = ("5 3\n1 2 1\n1 3 2\n3 4 3\n3 5 1\n", 6)
    return example, gen


def safe_strings():
    def brute(length, s, words):
        count = 0
        for t in itertools.product("abcdefghijklmnopqrstuvwxyz", repeat=length):
            t = "".join(t)
            if t <= s and not any(w in t for w in words):
                count += 1
        return count % MOD

    def gen(rng):
        length = rng.randint(1, 3)
        s = "".join(rng.choice("abcd") for _ in range(length))
        words = ["".join(rng.choice("abc") for _ in range(rng.randint(1, 3))) for _ in range(rng.randint(1, 3))]
        text = f"{length} {s}\n{len(words)}\n" + "".join(w + "\n" for w in words)
        return text, brute(length, s, words)

    example = ("3 bca\n2\nab\ncc\n", 700)
    return example, gen


def subarray_k():
    def gen(rng):
        n = rng.randint(1, 30)
        a = [rng.randint(-3, 3) for _ in range(n)]
        k = rng.randint(-3, 3)
        want = sum(1 for i in range(n) for j in range(i, n) if sum(a[i : j + 1]) == k)
        return f"{n} {k}\n{' '.join(map(str, a))}\n", want

    return ("6 2\n1 2 1 -1 2 0\n", 6), gen


def lis():
    def brute(a):
        best = [1] * len(a)
        for i in range(len(a)):
            for j in range(i):
                if a[j] < a[i]:
                    best[i] = max(best[i], best[j] + 1)
        return max(best, default=0)

    def gen(rng):
        n = rng.randint(1, 40)
        a = [rng.randint(-5, 10) for _ in range(n)]
        return f"{n}\n{' '.join(map(str, a))}\n", brute(a)

    return ("8\n3 1 4 1 5 9 2 6\n", 4), gen


def distinct_substrings():
    def gen(rng):
        s = "".join(rng.choice("ab" if rng.random() < 0.5 else "abc") for _ in range(rng.randint(1, 30)))
        want = len({s[i:j] for i in range(len(s)) for j in range(i + 1, len(s) + 1)})
        return f"{s}\n", want

    return ("abab\n", 7), gen


def inversions():
    def gen(rng):
        n = rng.randint(1, 40)
        a = [rng.randint(-5, 5) for _ in range(n)]
        want = sum(1 for i in range(n) for j in range(i + 1, n) if a[i] > a[j])
        return f"{n}\n{' '.join(map(str, a))}\n", want

    return ("5\n3 1 2 5 4\n", 3), gen


def strict_cost():
    def brute(a):
        values = range(-15, 30)
        best = {v: abs(a[0] - v) for v in values}
        for x in a[1:]:
            nxt = {}
            running = float("inf")
            for v in values:
                nxt[v] = running + abs(x - v)
                running = min(running, best[v])
            best = nxt
        return min(best.values())

    def gen(rng):
        n = rng.randint(1, 8)
        a = [rng.randint(0, 10) for _ in range(n)]
        return f"{n}\n{' '.join(map(str, a))}\n", brute(a)

    return ("4\n2 1 5 3\n", 5), gen


CASES = {
    "tree_pairs": tree_pairs,
    "safe_strings": safe_strings,
    "subarray_k": subarray_k,
    "lis": lis,
    "distinct_substrings": distinct_substrings,
    "inversions": inversions,
    "strict_cost": strict_cost,
}


def run(solution, text):
    out = subprocess.run(
        [sys.executable, solution], input=text, capture_output=True, text=True, timeout=20
    )
    tokens = out.stdout.split()
    if not tokens:
        raise RuntimeError(f"no output; stderr: {out.stderr.strip()[-300:]}")
    return int(tokens[-1])


def main():
    case_id, solution = sys.argv[1], sys.argv[2]
    (example_text, example_want), gen = CASES[case_id]()
    try:
        got = run(solution, example_text)
        if got != example_want:
            print(json.dumps({"ok": False, "detail": f"example: want {example_want}, got {got}"}))
            return
        rng = random.Random(11)
        for trial in range(40):
            text, want = gen(rng)
            got = run(solution, text)
            if got != want:
                print(json.dumps({"ok": False, "detail": f"random #{trial}: want {want}, got {got}; input {text!r}"}))
                return
        print(json.dumps({"ok": True, "detail": "example + 40 random cases match brute force"}))
    except Exception as err:  # noqa: BLE001
        print(json.dumps({"ok": False, "detail": f"{type(err).__name__}: {err}"[:400]}))


if __name__ == "__main__":
    main()
