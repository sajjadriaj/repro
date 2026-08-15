# Compile this reproduction

repro turned the bug report into a draft spec at `.repro/repro.yaml`.
The scenario still needs to be written.

## The bug report

> Checkout returns 500 after changing the shipping address twice and applying SAVE20

## What repro detected

| fact | value |
| --- | --- |
| framework | unknown |
| language | javascript |
| package manager | npm |
| start command | npm run dev |
| base url | http://localhost:3100 |
| database | none detected |
| setup scripts | npm run db:reset, npm run seed |
| test runner | none |
| playwright | not installed |



## What repro could not infer

The scenario below is a stub. Replace it with the real sequence of
actions that triggers the bug. Everything else was detected from the repo.

## Your job

1. Read the code paths the report implicates.
2. Fill in `scenario:` with concrete, executable steps.
3. Set `failure.reproduce` to the observable symptom (status, exception, log line).
4. Run `repro run` until it prints `FAILURE REPRODUCED`.
5. Run `repro run --repeat 10` to measure whether the bug is deterministic or flaky.
6. Run `repro minimize` to cut the scenario down to what actually matters.

Do not fix the bug yet. A reproduction that fails reliably is the deliverable.

## Step reference

```yaml
scenario:
  # shell
  - shell: npm run seed
    expect: { exit_code: 0 }

  # http — url is relative to base_url
  - name: create user
    http:
      method: POST
      url: /api/users
      json: { email: test@example.com }
    expect: { status: 201 }
    save: { userId: $.id }          # reuse later as ${userId}

  - http: { method: POST, url: /api/users/${userId}/cart }

  # browser (needs playwright installed)
  - browser:
      - goto: /checkout
      - fill: { selector: "#coupon", value: SAVE20 }
      - click: "#submit"
      - wait_for: "#error"
      - screenshot: after-submit

  # pause
  - sleep: 250
```

### Matcher fields

`status`, `status_in`, `status_not`, `body_contains`, `body_matches` (regex),
`json` (map of `$.path` to expected value), `exception`, `exit_code`,
`stdout_contains`, `stderr_contains`, `logs_contain`.

### Rules that matter

- `failure.reproduce` defines "reproduced". Make it specific — `{ status: 500 }`
  alone will also match an unrelated crash.
- An `expect` on a step *before* the failure step is a precondition. If it
  fails, the run is reported as an error, not as a reproduction. Use this to
  stop the minimizer from deleting steps that silently matter.
- Mark a step `keep: true` to protect it from the minimizer.
- `failure.step` selects the failing step by id, name, or 1-based index.
  It defaults to the last step.
