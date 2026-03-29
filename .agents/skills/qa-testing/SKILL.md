---
name: qa-testing
description: Manually QA test the Electron app end-to-end using Playwright and the dev server. Use when verifying UI features, testing user flows, or performing manual QA after implementing a spec phase.
---

# QA Testing

Test the Electron app end-to-end using the Playwright skill and the dev server.

## Setup

```bash
.bin/dev start
.bin/dev status          # note the CDP URL and tmux session name
sleep 10
.bin/playwright connect <cdp-url> --session <session-name>
```

Always wait ~10s after `start` before connecting.

## Workflow

1. Connect Playwright to the running Electron app (see Setup).
2. Take a snapshot to see current state: `.bin/playwright snapshot --session <s>`
3. Interact with the app using `.bin/playwright exec '<code>' --session <s>`
4. Take a snapshot after every interaction to verify the result.
5. Repeat until the feature/fix is verified.

Refer to the **playwright** skill for command syntax and examples.

## Common Selectors

- New Chat: `button:has-text("New Chat")`
- Chat input: `.tiptap`
- Send: `button[aria-label="Send message"]` or `Meta+Enter`
- Sidebar nav: `button:has-text("To Do")`, `button:has-text("Archive")`, `button:has-text("Settings")`

## Sending a Message

```bash
.bin/playwright exec 'await page.locator(".tiptap").click()' --session <s>
.bin/playwright exec 'await page.keyboard.type("Hello")' --session <s>
.bin/playwright exec 'await page.keyboard.press("Meta+Enter")' --session <s>
.bin/playwright snapshot --session <s>
```

## Teardown

```bash
.bin/playwright close --session <s>
.bin/dev stop
```
