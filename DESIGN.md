Overview
By Chat is a modern private-messaging interface built around a calm, bright canvas and a restrained blue accent. The system uses soft white surfaces ({colors.canvas} — #ffffff), mist-gray backgrounds ({colors.cloud} — #f7f8fa), and deep charcoal text ({colors.ink} — #17202a). A single clear accent — By Chat Blue ({colors.primary} — #2563eb) — highlights primary actions, active navigation, and important links. Pale blue outgoing-message bubbles create a subtle visual distinction without turning the conversation into a saturated interface.
The visual language is quiet and functional: generous white space, thin cool-gray dividers, rounded message bubbles, and restrained elevation. The chat experience should feel familiar and readable, while status, profile settings, and moderation tools share the same token system. Unlike a product catalog, By Chat has no need for decorative hero graphics; the main visual focus is the conversation itself.
The system has three surface modes: a white conversation surface for chat lists, messages, and dialogs; a soft gray canvas for the overall application and empty states; and a deep ink surface reserved for occasional high-contrast notices or footer-like utility areas. Blue should remain an action color rather than a large background fill.
Key Characteristics:
- Soft white canvas ({colors.canvas}) and pale gray app background ({colors.cloud}) establish a clean, low-distraction interface.
- By Chat Blue ({colors.primary}) is reserved for primary buttons, links, active states, and selected navigation.
- Outgoing messages use pale blue ({colors.bubble-out}); incoming messages remain white ({colors.bubble-in}).
- Deep ink ({colors.ink}) handles primary text; muted gray ({colors.text-muted}) handles timestamps and secondary labels.
- Cards and dialogs use soft 12–16px corners; buttons and inputs use a consistent 8px radius.
- Green and red are semantic colors for online/success and errors/destructive actions, not decorative accents.
- The conversation remains the visual priority; shadows and borders should never compete with message content.
Colors
Brand & Accent
- By Chat Blue ({colors.primary} — #2563eb): the primary signal color for main actions, links, selected navigation, and focus indicators.
- Deep Blue ({colors.primary-deep} — #1d4ed8): a deeper blue used for pressed primary actions and stronger emphasis.
- Soft Blue ({colors.primary-soft} — #e8f0ff): a pale blue surface for outgoing message bubbles and selected items.
- Blue Tint ({colors.primary-tint} — #eff6ff): a very light blue used for subtle selected backgrounds or small informational accents.
Surface
- Canvas ({colors.canvas} — #ffffff): main surface for conversation panels, cards, dialogs, and chat-list rows.
- Cloud ({colors.cloud} — #f7f8fa): main application background and empty-state canvas.
- Fog ({colors.fog} — #eef1f5): secondary surface for subtle panel separation and hover-neutral backgrounds.
- Paper ({colors.paper} — #ffffff): elevated card and modal surface, separated by a border or soft shadow.
- Border ({colors.border} — #e4e8ef): fine dividers, input outlines, and panel boundaries.
- Steel ({colors.steel} — #c5ccd6): stronger outline for disabled or emphasized control boundaries.
- Ink Surface ({colors.ink-surface} — #17202a): optional dark surface for high-contrast utility areas.
Text
- Ink ({colors.ink} — #17202a): primary text, contact names, headings, and message content.
- Text Muted ({colors.text-muted} — #687385): timestamps, helper text, metadata, and secondary labels.
- Text Soft ({colors.text-soft} — #8a94a4): low-priority metadata and placeholder text; keep contrast readable.
- On Ink ({colors.on-ink} — #ffffff): text and icons on dark ink surfaces.
- On Primary ({colors.on-primary} — #ffffff): text and icons on blue primary buttons.
Semantic
- Success Green ({colors.success} — #15803d): online indicators and successful actions.
- Success Tint ({colors.success-soft} — #dcfce7): pale green background for non-intrusive success notices.
- Danger Red ({colors.danger} — #dc2626): errors, report actions, and destructive actions such as blocking a user.
- Danger Tint ({colors.danger-soft} — #fee2e2): pale red background for error messages and destructive-action confirmation.
- Warning Amber ({colors.warning} — #b45309): warnings such as pending reports or connection interruptions.
- Warning Tint ({colors.warning-soft} — #fef3c7): pale amber background for warning banners.
- Offline Gray ({colors.offline} — #9ca3af): offline indicators when paired with a readable label.
Typography
Font Family
Use a neutral, highly readable sans-serif family throughout the interface: Inter, with system-ui, -apple-system, Segoe UI, and sans-serif fallbacks. Inter's clean shapes work well for chat messages, compact timestamps, profile forms, and admin tables. Use weight 400 for body text, 500 for labels and contact names, and 600 for headings or primary button labels. Avoid overly decorative type; message content should remain the clearest element on screen.
Hierarchy
Token	Size	Weight	Line Height	Use
{typography.display-lg}	28px	600	1.15	Login heading or major page title
{typography.display-md}	24px	600	1.2	Main panel headings
{typography.display-sm}	20px	600	1.25	Dialog and section titles
{typography.heading-md}	16px	600	1.35	Contact names and card headings
{typography.body-lg}	16px	400	1.5	Main message content
{typography.body-md}	14px	400	1.5	Default UI text
{typography.body-emphasis}	14px	500	1.4	Contact names, labels, emphasized copy
{typography.caption-md}	12px	400	1.4	Timestamps and metadata
{typography.caption-sm}	11px	400	1.4	Compact secondary metadata
{typography.button-md}	14px	600	1.0	Button labels
{typography.username}	13px	500	1.3	Usernames and handles


Principles
Keep typography consistent and practical. Use weight and spacing rather than many colors to establish hierarchy. Message text should generally be 14–16px with comfortable line-height; timestamps can be smaller but must remain legible. Avoid all-caps for ordinary chat actions unless the existing interface specifically uses that treatment.
Layout
Spacing System
- Base unit: 4px, with the most common gaps at 8px, 12px, 16px, 24px, and 32px.
- Tokens: {spacing.xxs} 4px · {spacing.xs} 8px · {spacing.sm} 12px · {spacing.md} 16px · {spacing.lg} 20px · {spacing.xl} 24px · {spacing.xxl} 32px.
- Panel padding: 16–24px depending on panel size.
- Message spacing: 8–12px between separate message groups, tighter for consecutive messages from the same person.
- Application gutters: 16px on mobile, 24px on tablet, and 24–32px on desktop.
Grid & Container
- Desktop: a flexible chat list sidebar, a large conversation panel, and an optional details panel.
- Tablet: keep the chat list and conversation as primary areas; details can open in a drawer.
- Mobile: show either the chat list or an active conversation, with a clear back action.
- Admin: use a compact header, summary cards, tabs, and stacked report cards or a responsive table.
Elevation & Depth
Level	Treatment	Use
0 — Flat	No shadow; surface color provides separation.	Main background and conversation surfaces
1 — Hairline	1px solid {colors.border} border.	Inputs, dividers, outlined controls
2 — Soft Lift	0 2px 8px rgba(23, 32, 42, 0.06).	Menus, cards, profile dialogs
3 — Modal	0 8px 24px rgba(23, 32, 42, 0.12).	Confirmation dialogs and mobile sheets


Use elevation sparingly. The chat layout should feel calm and structured, not like a dashboard made of floating cards.
Shapes
Border Radius Scale
Token	Value	Use
{rounded.none}	0px	Dividers and flat section bands
{rounded.xs}	4px	Small labels and compact controls
{rounded.sm}	6px	Small secondary controls
{rounded.md}	8px	Buttons and inputs
{rounded.lg}	12px	Panels, menus, and dialogs
{rounded.xl}	16px	Chat containers and larger cards
{rounded.bubble}	16px	Message bubbles
{rounded.pill}	9999px	Status indicators and compact filter chips


Message bubbles may use a slightly smaller corner on the edge nearest the sender to distinguish incoming and outgoing messages, but keep the shape consistent throughout the conversation.
Components
Buttons
button-primary
- Background {colors.primary}, text {colors.on-primary}, 44px minimum height, 8px radius.
- Use for key actions such as Kirim, Bagikan, and Simpan.
- Keep one primary action visually dominant within each dialog.
button-secondary
- White background, ink text, 1px {colors.border} outline, 8px radius.
- Use for Batal, Tutup, and non-destructive secondary actions.
button-danger
- Danger red background with white text for destructive actions that need strong emphasis.
- Use carefully for confirmed actions such as blocking an account.
button-text
- Transparent background with blue text.
- Use for low-emphasis actions and inline navigation.
Chat Bubbles
message-bubble-outgoing
- Background {colors.bubble-out}, text {colors.ink}, rounded 16px.
- Timestamp uses {colors.text-muted}.
- Keep blue pale enough that long messages remain comfortable to read.
message-bubble-incoming
- Background {colors.bubble-in}, text {colors.ink}, 1px subtle border where needed.
- Timestamp uses {colors.text-muted}.
- Visually distinct from outgoing messages without adding another accent color.
Inputs
text-input
- White background, ink text, border {colors.border}, 8px radius, 44px minimum height.
- Placeholder uses {colors.text-soft}.
- Focus state uses a clear blue outline or border, not color alone.
message-composer
- White or cloud surface with a subtle border.
- Message text stays high contrast; attachment and send actions use clear icons and labels where space allows.
Navigation
chat-list-item
- Default background transparent or white.
- Selected item uses {colors.primary-tint} with a clear text/icon cue.
- Unread count may use {colors.primary} as a small badge.
status-indicator
- Online: {colors.success}.
- Offline: {colors.offline}.
- Always pair color indicators with text or accessible labels where practical.
App Shell

- Desktop uses an icon **rail** (76px) on the far left: logo, then Chats, Status, Calls, and Settings, with the signed-in avatar pinned at the bottom. The active item sits on {colors.canvas} over the {colors.cloud} rail surface, uses {colors.primary} for the icon, and may show a {colors.primary} count badge.
- The active list panel and the conversation stay on {colors.canvas}, separated by 1px {colors.border} hairlines; the rail itself is {colors.cloud}, so the two never read as one flat sheet.
- Panel changes are animated, not instant: a short 240ms fade-and-lift (`view-in`) for the panel, and colour transitions on the menu buttons.
- On mobile (< 760px) the rail is replaced by a floating **tab bar**: {rounded.pill} corners, 14px above the safe-area edge, translucent {colors.canvas} at roughly 72% opacity, `backdrop-filter: blur(20px) saturate(180%)`, and the Level 3 shadow. It is the only glassy surface in the product.
- The active tab uses {colors.primary-tint} with {colors.primary} icon and label; the tab bar hides while a conversation is open, so the conversation owns the screen.

Admin & Reports
admin-summary-card
- White surface, subtle border, 12px radius.
- Number uses ink; supporting label uses muted text.
- Semantic colors appear only when a metric represents a warning or urgent state.
report-status
- Pending: warning amber with warning tint.
- Completed: success green with success tint.
- Dismissed or blocked: neutral or danger treatment depending on meaning.
- Do not use red for ordinary navigation or non-destructive actions.
Responsive Behavior
Breakpoints
Name	Width	Key Changes
Mobile	< 480px	Single active view, compact header, full-width composer
Mobile-Large	480–767px	Same single-view navigation with more spacing
Tablet	768–1023px	Chat list and conversation can share the screen
Desktop	1024px+	Sidebar and conversation visible together; optional details panel


Touch Targets
Interactive elements should be at least 44×44px where practical. Keep sufficient spacing between icon buttons, particularly in the conversation header and message composer.
Do's and Don'ts
Do
- Reserve {colors.primary} for important actions, links, and selected states.
- Use white and pale gray surfaces to keep conversations calm and readable.
- Use pale blue only for outgoing messages and subtle selection backgrounds.
- Keep timestamps and metadata muted without making them difficult to read.
- Use green, red, and amber only for their semantic meanings.
- Maintain consistent radii and spacing across chat, settings, status, and admin views.
Don't
- Don't use bright blue as a large page background.
- Don't add extra accent colors without a clear semantic purpose.
- Don't use heavy shadows on every panel.
- Don't use red for ordinary buttons or navigation.
- Don't reduce text contrast just to make the interface look softer.
- Don't imply that the interface's color or security labels prove E2EE is implemented.