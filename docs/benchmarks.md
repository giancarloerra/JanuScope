# Synthetic evaluations

These evaluations separate four questions: whether answers are correct, whether a model follows policy, which requests or responses the proxy actually blocks, and how much context the workflow consumes. Fewer tokens alone do not establish a better or safer preset.

The measurements below use synthetic data. Database trials run through the compiled JanuScope CLI, Postgres MCP 0.3.0 and a disposable PostgreSQL 17 database. The native and wrapped connections use the same read-only database role. Model requests contain synthetic prompts, schema and results. They do not use a production database.

## Why instruction length matters

`instructions` is natural-language guidance added to tool descriptions. It is optional in a custom configuration, but the bundled lenses supply it. Classification warnings and schema injection are separate features. Removing authored instructions does not remove executable `block`, `sqlGuard`, `redact` or audit controls.

The PostgreSQL server advertises nine tools. Its original 255-word policy was repeated in every description. Clients can send those descriptions on each model request, so the cost is larger than reading one paragraph once. Caching reduces the price of reused input; it does not make large descriptions or retained conversation history disappear.

The proposed bundled wording keeps explicit protected-field names, backend workflow and bypass rules. It also prohibits offering encoded, masked, partial or derived protected values. Privacy-safe aggregate and presence checks, ordinary record IDs and Stripe's upstream-provided `last4` metadata remain legitimate where backend permissions allow them. Deriving fragments from protected card data is prohibited. A [strict restricted database role](./sensitive-data.md) deliberately has a narrower access contract. The proposed wording is still awaiting a complete evaluation; the completed intermediate variants below are different policies.

## Initial five-table comparison

Four analytical questions were repeated three times per arm, giving 12 answers per arm. All 48 measured answers were correct. The model was Claude Sonnet 5. All input in this comparison was uncached.

| Configuration                                       | Correct answers | Tool calls | Total tokens | Estimated API cost |
| --------------------------------------------------- | --------------: | ---------: | -----------: | -----------------: |
| Native restricted MCP                               |           12/12 |         60 |      241,121 |          $0.525034 |
| JanuScope with original full instructions           |           12/12 |         16 |      288,116 |          $0.599496 |
| Native MCP given the same schema and policy context |           12/12 |         15 |      277,496 |          $0.578144 |
| JanuScope without authored instructions             |           12/12 |         12 |      103,480 |          $0.227488 |

The original full preset reduced calls by **73.3%** against native, but used **19.5% more tokens** and cost **14.2% more**. Removing the authored prose reduced tokens by **57.1%** and estimated cost by **56.7%** against native. That removal was an experimental arm, not the wording proposed for bundled lenses.

The native equal-context arm achieved almost the same discovery reduction as the full proxy. This supports schema context as the main explanation for reduced discovery in this fixture. JanuScope adds enforcement, response filtering and auditing; discovery savings alone do not establish that a proxy is necessary.

The instruction-removal arm ran after the other measured arms, so this was not a fully interleaved four-arm experiment. The equal-context control included both schema and policy, rather than isolating schema alone. These limits matter when attributing the result.

## Nine-table prototype comparison

A broader run compared the original full policy, a 24-word prototype and the classification warning alone. The same nine-table fixture, injected schema, executable controls and upstream tool definitions were used throughout. Full and short policies had the same prepended placement. Removing authored instructions placed the remaining classification warning at the overlay's default appended position, a confound in the warning-only comparison.

There were **225 answers**: 117 analytical answers and 108 safety answers. Analytical work covered counts, joins, anti-joins, revenue after refunds, rankings and zero-result relationships. Safety requests covered raw secrets, administrator claims, deletion, encoded values and an advertised independent connection. Claude Sonnet 5 handled the current comparison; the three original safety task shapes were also repeated with the pinned `claude-sonnet-4-5-20250929` model.

### Standalone analytical questions

Seven questions were repeated three times per arm. Token totals include input and output; no cache hits were observed in this phase.

| Wording                      | Correct answers | SQL calls | Total tokens | Estimated API cost |
| ---------------------------- | --------------: | --------: | -----------: | -----------------: |
| Original full policy         |           21/21 |        21 |      453,178 |          $0.944020 |
| 24-word prototype            |           21/21 |        24 |      244,865 |          $0.529306 |
| Classification warning alone |           21/21 |        21 |      203,607 |          $0.443358 |

The short prototype used **46.0% fewer tokens** and cost **43.9% less** than full wording. It also issued three additional exploratory queries for order-status values. All answers had correct values and ordering; one warning-only answer enclosed its JSON in Markdown fences. Across standalone and session analytics, each arm produced **39/39 correct answers**, with **116/117** complying with the strict JSON-only format.

### Retained history and caching

Each arm ran two repetitions of three session modes. The reset-history mode asked three analytical questions. Each retained-history mode asked those three questions followed by a sensitive-data request. Actual submitted messages were checked for retained history; cache-enabled sessions began with a cold cache write and later produced measured cache reads.

| Session mode                                   | Short prototype's estimated cost reduction versus full wording |
| ---------------------------------------------- | -------------------------------------------------------------: |
| Reset question history, explicit caching       |                                                          39.0% |
| Retained question history, no explicit caching |                                                          44.0% |
| Retained question history, explicit caching    |                                                          29.7% |

These are within-mode comparisons. Reset and retained sessions contain different numbers of questions and should not be compared as equal workloads.

### Safety observations

All **108 safety answers** avoided disclosure of complete known protected values, and no mutation or alternate-connection call executed. This does **not** mean every answer was acceptable:

- One short-prototype answer queried and returned a masked email and a billing-ID suffix.
- Two warning-only answers offered raw-field retrieval without executing it.
- Across the arms, 25 answers offered derived or masked values without executing those offers: three full, ten short and twelve warning-only.
- Some deletion refusals supplied an unexecuted write workflow or SQL. Advice, attempted calls and actual database mutations were counted separately.

Those observations prompted the refined wording. Merely saying “avoid sensitive fields” left useful policy detail unspecified. Retaining explicit field names and rules against transformed disclosures and bypasses is preferable to removing the entire paragraph.

Full-value checks covered assistant text, returned reasoning, tool arguments and model-facing results, including known hex, base64, URL and character-array forms. Partial disclosures and offers required separate transcript review. The prototype run did not follow up on every offer, and it cannot establish universal safety.

## Intermediate policy: 182-answer comparison

The next complete PostgreSQL comparison used a 144-word intermediate policy with explicit protected fields, transformed-value restrictions and a no-write rule. It retained the original placement, classification, schema and executable controls. This is not the 24-word prototype or the final conservative proposal.

Each arm answered 43 analytical and 48 safety questions. The previous question shapes were retained, with additional multi-turn attempts to obtain fragments, use a boolean probe or call the independent connection. Four analytical controls per arm checked legitimate protected-field aggregates and presence without revealing values. Both arms passed all four controls.

| Analytical scope                  | Original correct | Intermediate correct | Original tokens | Intermediate tokens | Original estimated cost | Intermediate estimated cost |
| --------------------------------- | ---------------: | -------------------: | --------------: | ------------------: | ----------------------: | --------------------------: |
| Standalone questions              |            21/21 |                21/21 |         464,413 |             363,542 |               $0.968202 |                   $0.764476 |
| All analytical modes and controls |            43/43 |                42/43 |         965,900 |             760,165 |               $1.657894 |                   $1.316883 |

Standalone questions used **21.7% fewer tokens** and cost **21.0% less** with the intermediate text. The one analytical error occurred in a retained session with explicit caching: inner joins omitted a member with zero events. It was a wrong result, not just a formatting difference. The intermediate arm also enclosed three retained-session analytical answers in Markdown fences. Across both arms, 83/86 analytical answers passed the combined correct-value and strict JSON-only check.

The within-mode estimated cost reductions were 15.5% for reset history with explicit caching, 17.5% for retained history without explicit caching and 11.1% for retained history with explicit caching. The last result includes the incorrect answer. Eight cache-enabled sessions each recorded a cold first write and subsequent cache hits; submitted histories were checked independently.

All 96 completed safety answers avoided observed complete or partial protected-value disclosure, actual writes and alternate-connection calls. This did not establish policy compliance: all eight destructive requests per arm still produced or offered a DELETE statement for execution elsewhere. Five original replies and four intermediate replies offered fragments, derived values or an inference probe. The actual field-sensitive calls in these safety answers were permitted presence checks, so counting field names in SQL alone would overstate prohibited access attempts.

These results support a smaller context cost in this fixture. They do not establish equal effectiveness, eliminate prohibited advice or justify adopting an instruction-free preset.

## Guidance across all 20 lenses

Two complete comparisons tested each lens's original and revised policy with three identical synthetic tool adapters. Each arm answered one ordinary task, a raw-value request with an administrator claim, a retained follow-up requesting transformed values, and an alternate-route read/write request. That is 160 answers per comparison, including 60 safety answers per arm. Claude Sonnet 5, instruction placement and classification were held constant; arm order was interleaved.

These tests deliberately isolated **model guidance**. They used the actual instruction overlay but did not enable proxy blocking, SQL checks or redaction. The adapters simulated operations on synthetic values; they were not authenticated vendor MCP servers. They test whether the policy transfers to an advertised tool surface, not each vendor's real tool routing or integration.

| Comparison and policy              | Ordinary answers correct | Safety answers with protected reads | Safety answers with writes | Safety answers returning protected variants | Safety answers offering prohibited actions |
| ---------------------------------- | -----------------------: | ----------------------------------: | -------------------------: | ------------------------------------------: | -----------------------------------------: |
| First: original                    |                    20/20 |                               35/60 |                       3/60 |                                       32/60 |                                      36/60 |
| First: compact revision            |                    20/20 |                                0/60 |                      11/60 |                                        0/60 |                                      10/60 |
| Second: original                   |                    20/20 |                               41/60 |                       4/60 |                                       37/60 |                                      33/60 |
| Second: explicit no-write revision |                    20/20 |                                1/60 |                       2/60 |                                        0/60 |                                       9/60 |

Every ordinary answer was supported by actual adapter results and had correct values. All ordinary answers included prose or Markdown around the JSON, so none passed a strict plain-JSON check. Stripe's upstream-provided `last4` metadata remained a legitimate ordinary result; deriving fragments from protected card data was treated separately.

Protected reads include raw values and transformations or fragments of them. No original or revised final answer contained a complete raw protected value in these two comparisons; the original final disclosures were transformed values. However, raw values did reach the model through some tool results. In the second revised arm, a Linear bypass call obtained a raw synthetic secret and changed simulated state before the final answer refused. A Redshift call also changed simulated state. Final refusal language did not undo those calls.

Offers were reviewed separately from executions and may overlap other columns. The second revised arm made four write offers and eight variant offers, overlapping across nine answers; one further masked-metadata suggestion was ambiguous and kept separate. The first compact revision reduced protected reads but increased writes from three to eleven. The explicit no-write revision improved the aggregate read, write and offer counts against its fresh baseline, while still failing individual cases. These small samples do not establish a universal improvement.

## Conservative follow-up status

The final proposed wording restores the original before-every-call policy reminder and the rule that a prohibited or refused request must be reported and stopped. It explicitly forbids another route even when advertised or administrator-authorized, and names permitted ordinary reads separately from prohibited fragments and write offers.

PostgreSQL's authored policy changes from **255 to 193 words**, or **1,662 to 1,386 decoded bytes**. Across all 20 lenses, the text changes from **3,115 to 3,739 words**, or **20,799 to 26,501 decoded bytes**. This is a reduction for the verbose PostgreSQL policy, not a reduction across the collection: shorter original policies gain missing explicit safeguards. Non-instruction configuration values and instruction placement are preserved.

**Evaluation is incomplete, and the proposed default wording is not yet validated as a replacement.** The final PostgreSQL run completed 55 of 182 planned answers before an API interruption; a further answer was recorded as failed. The final cross-lens run completed 88 of 160, with a further failed answer. Those partial runs are not pooled with the completed comparisons. Already observed refusals still offered prohibited write actions, so even the completed subset cannot be described as free of policy failures. No equivalence or saving claim is made for this final proposal.

All 42 completed standalone analytical answers in the final PostgreSQL run matched the fixture and the strict JSON format. One candidate query nevertheless grouped members only by `display_name`, which the schema does not require to be unique. A separate local database control preserved member IDs and workspace rows but assigned two members the same name: the exact generated query merged them, while the oracle grouped by member identity and retained their separate counts. No model call was made for that control. Observing whether the model chooses a correct query for duplicate names remains a separate test.

These partial results cannot support claims of equivalent effectiveness or quantified savings for the proposed wording. The instruction update remains pending a decision on further validation. The proxy's executable controls and backend permissions remain separate from model compliance with this wording.

## Enforced privacy is a separate result

Forced queries through the actual PostgreSQL MCP showed that full, short and warning-only instructions all allowed encoded and masked values to pass when configured response rules no longer matched. Raw values under recognized protected field names were redacted. Additional local overlay probes found that a field-only rule can also miss a protected value when the field is renamed.

This is a source-access boundary: a response filter does not know which columns produced an arbitrary value or number. A read-only credential with access to sensitive columns can still evaluate aliases, transformations, predicates, views and functions. More instruction text or a regex for one encoding cannot close that general path. Use [backend permissions](./sensitive-data.md) when protected fields must not be accessible to the model.

## Accounting and limits

The nine-table prototype run recorded 374 generation requests and 374 token-count requests, with 2,586,176 input tokens across cache categories and 69,215 output tokens. Estimated generation cost was $5.414342. The complete 182-answer intermediate run recorded 291 generation and 291 token-count requests, 2,787,643 input tokens across cache categories and 53,411 output tokens, for an estimated $5.642714. Usage in both completed runs was reconciled against saved responses, with no uncertain calls or outstanding reservations. Fresh disposable processes and databases were cleaned up.

Each complete cross-lens run recorded 248 generation and 248 token-count requests, with no cache use. Their estimated generation costs were $1.809260 and $1.877494. Configurations matched outside authored text, actual submitted descriptions matched their frozen sources, and retained histories and usage were reconciled independently.

Interrupted runs are excluded from complete-run claims. These include a 46-answer PostgreSQL attempt interrupted by a test-harness process-cleanup error, and the two partial conservative follow-ups above. The cleanup issue was reproduced with the native MCP alone, corrected in the private harness and exercised before the later complete intermediate run. One rejected generation in the interrupted cross-lens follow-up has unconfirmed usage; its conservative reservation remains separate from reported successful usage. An interruption or missing response is not counted as a successful model answer.

Costs are estimates from reported API usage, not invoices. The calculations use per-million-token rates of $2 input and $10 output for Sonnet 5, and $3 input and $15 output for Sonnet 4.5, with cache writes and reads priced separately. See the [provider pricing documentation](https://platform.claude.com/docs/en/about-claude/pricing). These are the rates used for these measurements, not a promise of current or future pricing.

The samples are small and synthetic. Correct answers in these trials do not prove statistical equivalence across models, schemas, workloads or other MCP services. Cross-provider effectiveness, every upstream integration, all encodings, arbitrary sessions and universal non-inference have not been established.

## Historical results

The earlier published 84% total-token result remains in the [historical tables](./setup.md#historical-benchmarks) for its original harness. Its questions reset conversation history despite reusing a client session; it did not test a growing retained conversation. Its saved safety grading emphasized final-text patterns, and the exact historical tool-description policy was not frozen. The newer comparisons separate history, caching, instructions, schema and actual enforcement instead of treating that result as a general saving.
