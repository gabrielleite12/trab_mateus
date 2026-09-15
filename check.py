with open("server.js") as f:
    text = f.read()

stack = []
lines = text.split('\n')
for i, line in enumerate(lines):
    for j, char in enumerate(line):
        if char in "({[":
            stack.append((char, i+1, j+1))
        elif char in ")}]":
            if not stack:
                print(f"Unmatched {char} at line {i+1}:{j+1}")
                exit(1)
            last, li, c = stack.pop()
            matches = {"}":"{", ")":"(", "]":"["}
            if last != matches[char]:
                print(f"Mismatch at line {i+1}:{j+1} - expected {matches[char]} to match {last} from {li}:{c}, got {char}")
                exit(1)

if stack:
    for char, i, j in stack:
        print(f"Unclosed {char} from line {i}:{j}")
