# Owner's brief, verbatim (Saran, 2026-11-01)

Kept so every work item's seed can carry the ask word for word. Do not edit the text below the line.

---

See the entire project and use the proper skill and then 
# SKETCH IDE -- COMPLETE UI/UX, BUG FIXING & FUNCTIONALITY OVERHAUL

## YOUR ROLE

You are now acting as all of the following:

1. Principal Software Engineer.
2. Senior UI/UX Designer.
3. Desktop Application Architect.
4. Frontend and Backend Engineer.
5. QA and Automation Engineer.
6. Product Designer.
7. Real Sketch IDE end user.

You have full responsibility for inspecting, understanding, testing, improving and fixing the entire Sketch IDE.

Your task is not simply to make the interface look attractive.

Your task is to make Sketch feel like a polished, professional, reliable, production-quality development environment.

Think of yourself as a developer who has just installed Sketch IDE and is going to use it every day. Explore the entire application as a real user would.

## 1. FIRST: EXPLORE THE ENTIRE PROJECT

Before changing anything, inspect the complete repository.

Do not inspect only the main frontend files.

Explore:

- Root directory.
- Every folder.
- Every subfolder.
- Frontend components.
- Backend services.
- API routes.
- Database layer.
- Authentication.
- AI provider integrations.
- Agent execution engine.
- Terminal integration.
- Filesystem operations.
- MCP implementation.
- Skills system.
- Model management.
- Chat system.
- Conversation persistence.
- Token tracking.
- Import/export.
- Git integration.
- Settings.
- Configuration files.
- CSS and design tokens.
- Desktop runtime.
- Build configuration.
- Dependencies.
- Error handling.
- Tests.

Read the important source files and understand how different modules communicate.

Build a mental map of the entire application before making architectural changes.

Do not assume a feature works just because its UI exists.

Trace its complete execution path from frontend to backend and verify actual functionality.

## 2. ACT AS A REAL USER AND EXPLORE THE ENTIRE IDE

Launch Sketch and interact with it.

Do not limit yourself to reading source code.

Use the application as an actual user.

Open every navigation item, menu, submenu, dialog, settings page, dropdown, tab and button.

Explore every available feature.

Test:
- Opening projects.
- Opening files.
- Creating files.
- Editing files.
- Switching tabs.
- Searching files.
- Using the terminal.
- Sending AI messages.
- Switching AI models.
- Changing Ask, Agent and Auto modes.
- Opening conversations.
- Creating new chats.
- Accessing Skills.
- Installing skills.
- Managing MCP servers.
- Managing agents.
- Opening settings.
- Changing configurations.
- Importing and exporting.
- Git operations.
- Running projects.
- Opening previews.
- Notifications.
- What's New.
- Keyboard shortcuts.

Inspect every screen at different window sizes.

If something does not work, investigate its implementation and fix it.

## 3. FIX ALL UI/UX PROBLEMS

Use the existing Sketch visual identity and improve it professionally.

The interface should feel like a premium developer tool.

Study the usability and interaction quality of professional development environments, but do not blindly copy their designs.

### Global layout

Check and fix:

- Incorrect spacing.
- Misaligned components.
- Inconsistent padding.
- Inconsistent margins.
- Broken panel layouts.
- Incorrect panel widths.
- Overlapping elements.
- Content overflow.
- Unnecessary scrolling.
- Incorrect z-index.
- Broken resizing.
- Inconsistent border radii.
- Inconsistent typography.
- Poor visual hierarchy.
- Inconsistent icons.
- Unnecessary empty space.
- Broken responsive behaviour.

### Sidebar

Improve:
- Navigation clarity.
- Icon consistency.
- Active states.
- Hover states.
- Tooltips.
- Sidebar collapse and expansion.
- Navigation spacing.
- Scroll behaviour.
- Section grouping.

### Editor

Inspect:
- File opening.
- File closing.
- Multiple tabs.
- Tab switching.
- Split editor.
- Editor sizing.
- Syntax highlighting.
- Empty states.
- Loading states.
- File errors.
- Context menus.
- Keyboard shortcuts.
- Search.
- Breadcrumbs.

### AI Chat and Agent panel

Inspect:
- Chat layout.
- Message alignment.
- User and assistant message styling.
- Code blocks.
- Markdown rendering.
- Streaming responses.
- Stop button.
- Retry button.
- Copy button.
- Message actions.
- Tool execution steps.
- Agent activity.
- Task progress.
- Model selector.
- Ask/Agent/Auto modes.
- Composer.
- Attachment controls.
- Dropdown menus.
- Chat scrolling.
- Conversation history.

Fix all visual and interaction issues.

### Skills page

The current Skills interface needs special attention.

Inspect:
- Registry layout.
- Installed tab.
- Search.
- Skill cards.
- Skill descriptions.
- Install buttons.
- Version labels.
- Skill permissions.
- Installation progress.
- Success and failure states.
- Skill details.
- Uninstall functionality.

Fix overlapping install buttons, incorrect alignment, overflowing text and poor card layouts.

If the marketplace is disabled in the current build, communicate this clearly and ensure that the available curated registry works properly.

### Settings

Inspect every settings category.

Ensure:
- Settings are properly grouped.
- Inputs have labels.
- Dropdowns work.
- Changes persist.
- Reset functionality works.
- Error messages are understandable.
- Sensitive information is protected.
- Configuration changes actually affect the application.

## 4. FIX ALL FUNCTIONAL BUGS

Perform a complete operational audit.

Pay particular attention to:

### Filesystem and workspace

- Incorrect project root.
- Incorrect file paths.
- Files outside workspace errors.
- Windows path handling.
- Relative versus absolute paths.
- Path normalisation.
- File reading.
- File writing.
- File creation.
- File deletion.
- Folder traversal.
- File watchers.
- Large file handling.

The application must correctly distinguish between the opened workspace root and nested project directories.

Investigate the reported error where Sketch attempts to open:

`C:\Users\saran\Downloads\unicef india\index.mjs`

while the application reports a different workspace boundary.

Determine the actual cause. Do not simply suppress the error or remove filesystem security restrictions.

Correct the workspace and path resolution architecture.

### AI functionality

Test:
- Every configured provider.
- API key validation.
- Model discovery.
- Model switching.
- Chat requests.
- Streaming.
- Tool calling.
- Context preservation.
- Token accounting.
- Agent execution.
- Tool permissions.
- Error handling.
- Retry.
- Cancellation.
- Conversation persistence.

Make sure the model displayed in the interface is the model actually handling the request.

Investigate unexpected multiple model calls and incorrect token counts.

### Agent functionality

Verify:
- Agent mode.
- Ask mode.
- Auto mode.
- Planning.
- File editing.
- Tool execution.
- Command approval.
- Multi-step tasks.
- Task history.
- Agent status.
- Cancellation.
- Recovery after errors.

The agent must not report that a task was completed if its changes were not successfully applied.

### Skills and MCP

Verify actual installation and execution.

Check:
- Skill discovery.
- Skill validation.
- Skill installation.
- Skill activation.
- MCP connection.
- MCP server status.
- MCP tool discovery.
- MCP tool execution.
- Permissions.
- Configuration persistence.

### Backend and application stability

Inspect:
- API errors.
- Broken routes.
- Incorrect state management.
- Race conditions.
- Memory leaks.
- Unhandled promise rejections.
- Process cleanup.
- Duplicate event listeners.
- Database errors.
- Corrupted configuration.
- Application startup.
- Application shutdown.

Fix root causes rather than adding superficial workarounds.

## 5. ESTABLISH A CONSISTENT DESIGN SYSTEM

Review the complete application and establish consistent design tokens.

Define:
- Background colours.
- Surface colours.
- Borders.
- Primary and secondary text.
- Accent colours.
- Typography.
- Font sizes.
- Spacing scale.
- Border radii.
- Shadows.
- Icon sizes.
- Component heights.
- Button variants.
- Input variants.
- Modal styles.
- Dropdown styles.

Maintain the existing Sketch dark identity and orange accent.

Improve contrast, readability and visual hierarchy.

Ensure all screens use the same design language.

Avoid unnecessary gradients, excessive animations and decorative UI.

## 6. MAKE THE INTERFACE FEEL FINISHED

Every feature must have appropriate states:

- Default.
- Hover.
- Focus.
- Active.
- Disabled.
- Loading.
- Success.
- Error.
- Empty.
- Offline.

No dead buttons.

No fake interactions.

No broken dropdowns.

No placeholder functionality presented as complete.

No text overflow.

No accidental overlapping.

No inconsistent spacing.

No unexplained empty panels.

Use clear confirmations for destructive actions.

## 7. TEST DIFFERENT WINDOW SIZES

Test Sketch at:

- 1920 x 1080.
- 1600 x 900.
- 1366 x 768.
- 1280 x 720.
- Smaller window sizes.

Check:
- Sidebar behaviour.
- Editor layout.
- Chat panel.
- Toolbar.
- Modals.
- Dropdowns.
- Skills cards.
- Settings.
- Scroll containers.

The application should remain usable when the window is resized.

## 8. DO NOT BREAK EXISTING FEATURES

Critical rules:

1. Do not rebuild working features unnecessarily.
2. Do not delete existing modules.
3. Do not remove working integrations.
4. Do not change authentication without a reason.
5. Do not break existing database schemas.
6. Do not replace real functionality with mock data.
7. Do not hardcode temporary fixes.
8. Do not hide errors instead of fixing them.
9. Do not bypass security checks.
10. Do not introduce unnecessary dependencies.
11. Preserve backward compatibility wherever practical.
12. Keep the architecture modular.

Before modifying shared components, understand which other modules depend on them.

## 9. WORK INDEPENDENTLY

Do not wait for me to point out every problem.

If you discover a bug, investigate and fix it.

If you discover poor UI design, improve it.

If you discover a dead button, trace and implement its intended functionality.

If you discover duplicated code, refactor carefully.

If you discover an architectural problem, propose and implement a safe improvement.

Make sensible engineering decisions independently.

Only stop for clarification when a decision genuinely requires product-owner input or access to an unavailable external resource.

## 10. TEST AFTER EVERY MAJOR CHANGE

After modifying a module:

- Run relevant tests.
- Run type checking.
- Run linting.
- Run the application.
- Verify the affected screen.
- Test the affected workflow.
- Inspect console errors.
- Inspect backend logs.
- Check for regressions.

Do not accumulate untested changes until the end.

## 11. FINAL QUALITY ASSURANCE

When implementation is complete, perform another complete user walkthrough.

Start Sketch from a clean application launch.

Open a project.

Explore the editor.

Use AI chat.

Run an agent task.

Edit files.

Run terminal commands.

Open Skills.

Test settings.

Test Git.

Test MCP if configured.

Test import/export.

Resize the window.

Navigate between all major sections.

Verify that the application remains stable throughout.

Fix any remaining problems.

## 12. FINAL DELIVERABLES

Create:

`docs/UI_UX_AUDIT.md`

`docs/BUG_AUDIT.md`

`docs/ARCHITECTURE_REVIEW.md`

`docs/FIXES_IMPLEMENTED.md`

`docs/FINAL_QA_REPORT.md`

Include:

- All inspected folders and modules.
- All identified bugs.
- Root causes.
- UI improvements.
- Functional fixes.
- Files modified.
- Dependencies added or removed.
- Tests executed.
- Tests passed.
- Tests failed.
- Remaining limitations.

## FINAL OBJECTIVE

I want you to transform the existing Sketch IDE into a polished, professional, stable and genuinely usable AI development environment.

Do not just inspect and report.

Do not just redesign the homepage.

Do not just make the buttons look better.

Explore the entire application like a real user, understand the complete codebase like a principal engineer, redesign it like a senior product designer and verify everything like a QA engineer.

Take ownership of the complete experience.

Start by exploring the repository and launching the existing application. Then systematically audit, fix, improve and verify the entire Sketch IDE.
