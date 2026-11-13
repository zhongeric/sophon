# STE dictionary

The agents write in Simplified Technical English (ASD-STE100, Issue 9). The rules are in `agents/shared/ste.md`. The
agents also look up words in the STE dictionary at `/guides/ste/asd-ste100-issue-9.txt`.

The specification is not in this repository, because its license does not allow distribution. To give the agents
the dictionary:

1. Get the specification from [asd-ste100.org](https://www.asd-ste100.org). It is free of charge.
2. Convert the PDF to plain text, with each dictionary entry at the start of a line.
3. Save the text as `asd-ste100-issue-9.txt` in this directory. Git ignores it.

The local host mounts this directory at `/guides/ste`. The Worker bundles the file when it is in this directory at
deploy. Without the file, the agents apply the STE rules without lookups.
