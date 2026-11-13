# Simplified Technical English (ASD-STE100, Issue 9)

ALWAYS write in Simplified Technical English when you talk to the user or when you write documentation or comments. This rule applies to: chat replies, documents, reports, design docs, code comments, and NatSpec. It does NOT apply to other text, for example: commit messages, PR titles and descriptions, code identifiers, test names, or tool inputs.

**Exception — technical terminology.** Use the correct technical term when the subject matter or the language requires it. Solidity, EVM, DeFi, and Uniswap terms are technical nouns and technical verbs (STE rules 1.5–1.13). Examples: `reentrancy`, `delegatecall`, `slippage`, `checksummed`, `mainnet`, `liquidity`. Do not replace a precise technical term with a simpler word that changes the meaning. Code itself (identifiers, syntax, command output) is out of scope.

## Words (Section 1)

- Use only words that the STE dictionary approves, plus technical nouns and technical verbs.
- Use each approved word only as its approved part of speech and only with its approved meaning. Example: "follow" is approved only as "come after", not as "obey".
- Do not use technical nouns as verbs, and do not use technical verbs as nouns.
- Do not use regional, slang, or jargon words as technical nouns.
- Use one term for one item. Do not use different terms for the same item.
- Use American English spelling.

## Noun clusters (Section 2)

- Write multi-word nouns of no more than three words. When a technical noun has more than three words, write it in full once, give an approved shorter form, and use that.

## Verbs (Section 3)

- Use only these verb forms: infinitive, imperative, simple present, simple past, simple future, and past participle as an adjective.
- Do not use complex verb constructions (no perfect or progressive tenses, no "would/could/should/might").
- Use the "-ing" form only in a technical noun or as a modifier in a technical noun.
- Use the active voice. In descriptive writing, you can use the passive voice only when the active voice is not possible or correct.
- Use a verb to describe an action, not a noun. Write "install the pump", not "do the installation of the pump".

## Sentences (Section 4)

- Write short and clear sentences. Do not omit words or use contractions to make a sentence shorter.
- Use a vertical list for complex text.
- Use connecting words to connect related sentences.
- Use an article (the, a, an) or a demonstrative adjective (this, these) before a noun when applicable.

## Procedures and instructions (Section 5)

- Use a maximum of 20 words in each sentence.
- Write only one instruction in each sentence, unless two or more actions occur at the same time.
- Write instructions in the imperative (command) form.
- When there is a condition, put the condition before the instruction.
- Write notes only to give information, not instructions.

## Descriptive writing (Section 6)

- Give information gradually. Use a maximum of 25 words in each sentence.
- Make sure that each paragraph has only one topic and no more than six sentences.

## Safety instructions (Section 7)

- Use a word such as "WARNING" or "CAUTION" to identify the level of risk.
- Start with a clear command or condition, then give an explanation to show the risk.

## Punctuation (Section 8)

- You can use all standard English punctuation marks, but not the semicolon.
- Use hyphens to connect words that are directly related.
- Use parentheses for references, asides, and letters or numbers in lists.

## Writing practices (Section 9 and GR-1 to GR-8)

- When a word-for-word rewrite does not obey a rule, use a different sentence construction.
- Do not make phrasal verbs (write "remove", not "take out").
- Keep the conjunction "that" after verbs such as "make sure". Make sure that each pronoun has a clear referent. Write "this valve", not a bare "this".
- Do not use Latin abbreviations ("e.g.", "i.e.", "etc."). Use "for example", "that is", "and so on".
- Use inclusive language. If you are not sure that a possessive ('s) is correct, use "of" instead.
- Use a consistent style for terminology and wording.

## Dictionary lookup

You do not have the full STE dictionary in memory. The full specification, with the dictionary of approved words and approved alternatives for unapproved words, is at `/guides/ste/asd-ste100-issue-9.txt`. When you are not sure that a word is approved, look it up:

```bash
grep -i -A4 "^myword " /guides/ste/asd-ste100-issue-9.txt
```

Entries in UPPERCASE are approved. Entries in lowercase are not approved, and the entry gives the approved alternative.
