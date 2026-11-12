# Social and notification integration findings

Final HTTP evidence: Newman report generated **12 November 2026, 21:03:08 (Asia/Saigon)**, run `mwdmaizj8fb20b`. The full HTTP suite executed 122 requests and 321 assertions; 6 assertions failed across all services. This report covers the Social/Notification findings only. Source tree: `5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf`.

All requests targeted the isolated `kirenz-integration` Docker project on loopback. No production or user-owned application data was used.

## Confirmed: a blocked user can still create comments

**Impact:** Blocking is enforced for post reads but not consistently for comment creation.

Reproduction in the ordered integration collection:

1. A creates a PUBLIC post; A and B are established friends.
2. Request **A blocks B and removes friendship** creates the User-service block.
3. Request **Blocked B cannot read A PUBLIC post** returns **404**, confirming that the block is active and PostService denies B access.
4. Request **SECURITY | Blocked B cannot comment on A post** submits a comment as B to the same A-owned PUBLIC post.
5. Expected **403/404**; actual **201**, with a successful response. The comment is created despite the active block.

The failing security assertion should remain a failure until application authorization is corrected. Do not accept 201 as an alternative successful test result.

Source evidence:

- `social-service/.../post/service/PostService.java:559` checks ownership, then `isBlocked`, before permitting PUBLIC visibility.
- `PostService.java:579` queries User-service `getBlockStatus`.
- `social-service/.../comment/service/CommentService.java:48` calls its own `visiblePost`.
- `CommentService.java:189` implements a separate visibility check and permits PUBLIC immediately at line 194, without querying block status.

**Related source concern, not runtime-verified in this report:** `reaction/service/ReactionService.java:229` uses the same privacy-only pattern and permits PUBLIC at line 234. Add a blocked-user reaction denial regression test; no confirmed reaction bypass is claimed here.

## Notification ownership is enforced, but returned status is misleading

An initial version of **SECURITY | Outsider notification access rejected** expected **403/404** and received **401**, with:

```json
{"success":false,"message":"Unauthorized"}
```

An independent read-only probe used the existing runtime fixtures without printing or exporting tokens:

| Request | A | Outsider |
| --- | --- | --- |
| Identity own profile | 200 | 200 |
| Notification own list | 200 | 200 |
| A's selected notification via gateway | 200 | 401 |
| A's selected notification direct to Notification-service | 200 | 401 |

Both credentials are valid. The outsider receives no notification payload, so the observed result is **access rejection**, not a data leak or invalid-token finding.

Source evidence:

- `notification-service/.../service/NotificationService.java:45` queries by both notification ID and receiver ID.
- Lines 46 and 52 throw `IllegalArgumentException` for a foreign or missing notification.
- No Notification-service controller advice maps that exception to a deliberate 403/404 response.
- `auth/JwtAuthenticationFilter.java:53` invokes the filter chain outside its token-parse catch block.
- `auth/SecurityConfig.java:34` requires authentication for every nonpublic route; lines 37–40 return the observed 401 envelope.

**Inference:** An unhandled exception followed by secured error dispatch likely masks the ownership/not-found result as 401. The read-only probe establishes the actual status and absence of data; it does not independently prove the error-dispatch internals.

The final authorization-denial check accepts **401/403/404 only when the response contains no foreign data** and passes. The status classification remains an error-contract observation. A 2xx payload or a 500 error is never accepted as successful authorization verification.

## Passing evidence and assertion guidance

- Nonowner comment editing returns **403**.
- Blocked-user post detail returns **404**.
- Notification owner detail and marking read use `data.isRead`.
- Reaction summary is `{totalCount,currentUserReaction,breakdown}`. On a fresh target, LIKE → LOVE preserves totalCount 1; repeating LOVE toggles it off.
- Sharing returns a PostResponse wrapper: `originalPostId` points to the original, `sharedPost.id` matches it, and the wrapper author is the sharing user.
- A root comment from B on A's post emits `POST_COMMENT` with receiver A, actor B, and targetId equal to the post ID. A notification poll should require all four fields rather than matching any event for the post.

The machine-readable Newman report may be replaced by later runs. The snapshot metadata above identifies the evidence used for this partial report.
