# Đăng nhập hub bằng Slack qua token-slayer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ai đăng nhập được Slack thì tự dùng được hub CCRC — PWA có nút "Đăng nhập bằng Slack", máy dev lấy token bằng device-code — mà hub không bao giờ cầm credential nào của token-slayer.

**Architecture:** token-slayer cấp một `IdeAccessToken` kiểu `one_time` gắn với `state`, rồi một endpoint riêng `POST /api/ccrc/auth/exchange` đổi nó lấy **danh tính và không gì khác** (không cấp bearer — xem spec §2.5). Hub tự đúc token của chính nó, khoá theo `slack_user_id`, lưu trong `data/users.json`. Toàn bộ phần hub biết về token-slayer nằm trong đúng một file `server/src/identity.js`.

**Tech Stack:** Node 22 ESM + Express 4 + `node:test` (hub) · Laravel 12 + Pest (token-slayer) · bash/sh (script máy dev)

**Spec:** `docs/superpowers/specs/2026-08-10-dang-nhap-slack-qua-token-slayer-design.md`

## Global Constraints

- **Hai repo khác nhau.** Task 1–2 nằm ở repo `token-slayer` (PHP), Task 3–12 ở repo này (Node). Đừng commit chéo.
- **Hub là ESM** (`"type": "module"` trong `server/package.json`). Dùng `import`, không `require`.
- **Không thêm dependency npm nào.** `fetch`, `AbortSignal.timeout`, `crypto` đều có sẵn trong Node 22.
- **Mọi chuỗi hiện cho người dùng viết bằng tiếng Việt.** Comment giải thích *tại sao* cũng viết tiếng Việt hoặc tiếng Anh theo đúng file đang sửa (xem file xung quanh).
- **Test chạy bằng:** `npm test --workspace server` (hub) · `npm test` (cả 3 workspace) · `./vendor/bin/pest` (token-slayer).
- **Đường cơ sở: 694 test đang xanh** (server 256, hook 46, term 392). Không được để tụt.
- **Luật script shell** (`server/test/shell-scripts.test.js` bắt buộc): mọi script phải qua `bash -n`/`sh -n`, và **không biến nào được đứng ngay trước ký tự không phải ASCII** (`$ttl…` là lỗi, `${ttl}s` thì được).
- **`admin` là tên dành riêng** (`server/src/users.js`). Mọi đường ghi `users.json` phải giữ nguyên chốt chặn này.
- **Không được ghi `users.json` khi luồng auth thất bại** ở bất kỳ bước nào (spec §6).
- **Token của user đã tồn tại KHÔNG được đổi khi họ đăng nhập lại** — đổi là đá văng mọi thiết bị khác của chính họ.

---

## File Structure

**Repo `token-slayer`:**

| File | Trách nhiệm |
|---|---|
| `app/Http/Controllers/Api/Ccrc/ExchangeController.php` *(mới)* | Đổi one-time token lấy `{slackUserId, handle}`, không cấp gì |
| `routes/api.php` | Đăng ký `POST /api/ccrc/auth/exchange` |
| `config/services.php` | `services.ccrc.callback_url` |
| `app/Http/Controllers/Auth/SlackController.php` | Nhánh `return=ccrc` |
| `tests/Feature/Api/Ccrc/ExchangeTest.php` *(mới)* | Test endpoint |
| `tests/Feature/Auth/SlackCcrcFlowTest.php` *(mới)* | Test nhánh OAuth + chống open redirect |

**Repo này:**

| File | Trách nhiệm |
|---|---|
| `server/src/users.js` | Shape `users.json` + `upsertBySlackId` + `removeUser` (thuần, không I/O) |
| `server/src/oauth-state.js` *(mới)* | Kho one-shot có TTL, dùng cho `state` và `claimCode` |
| `server/src/device-code.js` *(mới)* | Vòng đời `deviceCode`/`userCode` |
| `server/src/identity.js` *(mới)* | Lời gọi HTTP duy nhất tới token-slayer |
| `server/src/index.js` | Wiring: 6 route + `/link` + ghi `users.json` |
| `server/public/index.html` | Nút Slack, thẻ duyệt máy dev |
| `server/public/app.js` | Xử lý `?login=`, trang `/link` |
| `setup-notify.sh` | Device-code thay cho hỏi token |
| `deploy.sh` | `deluser` |
| `.env.example`, `docker-compose.yml`, `README.md` | Cấu hình + tài liệu |

---

## Task 1: Endpoint `/api/ccrc/auth/exchange` (token-slayer)

**Repo:** `token-slayer` — làm trước vì cần thời gian review của team.

**Files:**
- Create: `app/Http/Controllers/Api/Ccrc/ExchangeController.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/Ccrc/ExchangeTest.php`

**Interfaces:**
- Consumes: `IdeAccessToken::consumeOneTime(string $plain, string $state): ?User` (đã có)
- Produces: `POST /api/ccrc/auth/exchange` nhận `{token, state}` → `200 {slackUserId, handle}` hoặc `410 {error: "token_invalid_or_expired"}`

- [ ] **Step 1: Tạo branch**

```bash
git checkout -b feat/ccrc-identity-exchange
```

- [ ] **Step 2: Viết test thất bại**

Tạo `tests/Feature/Api/Ccrc/ExchangeTest.php`:

```php
<?php

use App\Models\IdeAccessToken;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;

uses(RefreshDatabase::class);

it('đổi one-time token lấy danh tính', function () {
    $user = User::factory()->create(['slack_user_id' => 'U01ABCDEF', 'slack_handle' => 'huy']);
    [$plain] = IdeAccessToken::issueOneTime($user, 'STATE123', 120);

    $this->postJson('/api/ccrc/auth/exchange', ['token' => $plain, 'state' => 'STATE123'])
        ->assertOk()
        ->assertJson(['slackUserId' => 'U01ABCDEF', 'handle' => 'huy']);
});

it('KHÔNG cấp token nào — đây là điều phân biệt endpoint này với luồng IDE', function () {
    $user = User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    [$plain] = IdeAccessToken::issueOneTime($user, 'STATE123', 120);
    $before = IdeAccessToken::count();

    $this->postJson('/api/ccrc/auth/exchange', ['token' => $plain, 'state' => 'STATE123'])
        ->assertOk();

    expect(IdeAccessToken::count())->toBe($before);
    expect(IdeAccessToken::whereKind('bearer')->count())->toBe(0);
});

it('từ chối khi state không khớp', function () {
    $user = User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    [$plain] = IdeAccessToken::issueOneTime($user, 'STATE123', 120);

    $this->postJson('/api/ccrc/auth/exchange', ['token' => $plain, 'state' => 'SAI'])
        ->assertStatus(410);
});

it('token chỉ dùng được một lần', function () {
    $user = User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    [$plain] = IdeAccessToken::issueOneTime($user, 'STATE123', 120);

    $this->postJson('/api/ccrc/auth/exchange', ['token' => $plain, 'state' => 'STATE123'])->assertOk();
    $this->postJson('/api/ccrc/auth/exchange', ['token' => $plain, 'state' => 'STATE123'])->assertStatus(410);
});

it('từ chối token đã quá hạn', function () {
    $user = User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    [$plain] = IdeAccessToken::issueOneTime($user, 'STATE123', 120);

    $this->travel(121)->seconds();

    $this->postJson('/api/ccrc/auth/exchange', ['token' => $plain, 'state' => 'STATE123'])
        ->assertStatus(410);
});
```

- [ ] **Step 3: Chạy test để chắc chắn nó fail**

Run: `./vendor/bin/pest tests/Feature/Api/Ccrc/ExchangeTest.php`
Expected: FAIL — 404 vì route chưa tồn tại.

- [ ] **Step 4: Viết controller**

Tạo `app/Http/Controllers/Api/Ccrc/ExchangeController.php`:

```php
<?php

namespace App\Http\Controllers\Api\Ccrc;

use App\Http\Controllers\Controller;
use App\Models\IdeAccessToken;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ExchangeController extends Controller
{
    /**
     * Đổi one-time token của luồng CCRC lấy DANH TÍNH — và không gì khác.
     *
     * Cố ý KHÔNG cấp bearer như luồng IDE: bearer đó sống lâu hơn và với xa
     * hơn nhiều so với thứ luồng này cần. Lý do chi tiết đã báo riêng cho
     * team token-slayer, không chép vào đây.
     *
     * Hub CCRC chỉ cần biết TÊN. Nên nó không được cầm thứ mạnh hơn thế.
     */
    public function __invoke(Request $request): JsonResponse
    {
        $data = $request->validate([
            'token' => ['required', 'string'],
            'state' => ['required', 'string'],
        ]);

        $user = IdeAccessToken::consumeOneTime($data['token'], $data['state']);

        if ($user === null) {
            return response()->json(['error' => 'token_invalid_or_expired'], 410);
        }

        return response()->json([
            'slackUserId' => $user->slack_user_id,
            'handle' => $user->displayHandle(),
        ]);
    }
}
```

- [ ] **Step 5: Đăng ký route**

Trong `routes/api.php`, thêm import và nhóm route mới **sau** nhóm `ide` đang có:

```php
use App\Http\Controllers\Api\Ccrc\ExchangeController as CcrcExchangeController;
```

```php
// Đầu vào của luồng đăng nhập CCRC. Cùng throttle với /api/ide, và KHÔNG nằm
// sau `ide.bearer`: đây là bước đổi one-time token, chưa ai có bearer cả.
Route::middleware('throttle:30,1')->prefix('ccrc')->group(function (): void {
    Route::post('/auth/exchange', CcrcExchangeController::class);
});
```

- [ ] **Step 6: Chạy test để chắc chắn nó pass**

Run: `./vendor/bin/pest tests/Feature/Api/Ccrc/ExchangeTest.php`
Expected: PASS — 5 test xanh.

- [ ] **Step 7: Chạy toàn bộ test để chắc không vỡ gì**

Run: `./vendor/bin/pest`
Expected: PASS toàn bộ.

- [ ] **Step 8: Commit**

```bash
git add app/Http/Controllers/Api/Ccrc/ExchangeController.php routes/api.php tests/Feature/Api/Ccrc/ExchangeTest.php
git commit -m "Add CCRC identity exchange that issues no credential

The CCRC hub needs to know who just logged in, nothing more. Routing it
through /api/ide/auth/exchange would hand it a bearer that is both
longer-lived and broader than this flow has any use for.

This endpoint consumes a one-time token and returns a name."
```

---

## Task 2: Nhánh OAuth `return=ccrc` (token-slayer)

**Files:**
- Modify: `config/services.php`
- Modify: `app/Http/Controllers/Auth/SlackController.php`
- Test: `tests/Feature/Auth/SlackCcrcFlowTest.php`

**Interfaces:**
- Consumes: `IdeAccessToken::issueOneTime(User $user, string $state, int $ttlSeconds): array{0: string, 1: self}` (đã có); endpoint từ Task 1
- Produces: `GET /auth/slack?return=ccrc&state=<state>` → sau Slack OAuth redirect về `config('services.ccrc.callback_url') . '?token=…&state=…'`

- [ ] **Step 1: Viết test thất bại**

Tạo `tests/Feature/Auth/SlackCcrcFlowTest.php`:

```php
<?php

use App\Models\IdeAccessToken;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Socialite\Facades\Socialite;
use Laravel\Socialite\Two\User as SocialiteUser;

uses(RefreshDatabase::class);

function fakeCcrcSlackUser(): SocialiteUser
{
    $u = new SocialiteUser;
    $u->map(['id' => 'U01ABCDEF', 'name' => 'Huy', 'nickname' => 'huy', 'email' => 'h@x.io', 'avatar' => null]);

    return $u;
}

it('lưu state vào session khi return=ccrc', function () {
    Socialite::shouldReceive('driver->redirect')->andReturn(redirect('https://slack.test/oauth'));

    $this->get('/auth/slack?return=ccrc&state=STATE123')->assertRedirect();

    expect(session('ccrc_oauth'))->toBe(['state' => 'STATE123']);
});

it('redirect về callback_url kèm token và state', function () {
    config(['services.ccrc.callback_url' => 'https://ccrc.example.com/auth/callback']);
    User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    Socialite::shouldReceive('driver->user')->andReturn(fakeCcrcSlackUser());
    session(['ccrc_oauth' => ['state' => 'STATE123']]);

    $response = $this->get('/auth/slack/callback');

    expect($response->headers->get('Location'))
        ->toStartWith('https://ccrc.example.com/auth/callback?')
        ->toContain('state=STATE123')
        ->toContain('token=');
});

it('cấp đúng một one_time token cho luồng ccrc, không cấp bearer', function () {
    config(['services.ccrc.callback_url' => 'https://ccrc.example.com/auth/callback']);
    User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    Socialite::shouldReceive('driver->user')->andReturn(fakeCcrcSlackUser());
    session(['ccrc_oauth' => ['state' => 'STATE123']]);

    $this->get('/auth/slack/callback');

    expect(IdeAccessToken::whereKind('one_time')->count())->toBe(1);
    expect(IdeAccessToken::whereKind('bearer')->count())->toBe(0);
});

it('KHÔNG bẻ hướng theo ?redirect= — đích đến chỉ đọc từ config', function () {
    config(['services.ccrc.callback_url' => 'https://ccrc.example.com/auth/callback']);
    User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    Socialite::shouldReceive('driver->user')->andReturn(fakeCcrcSlackUser());
    session(['ccrc_oauth' => ['state' => 'STATE123']]);

    $response = $this->get('/auth/slack/callback?redirect=https://evil.example.com');

    expect($response->headers->get('Location'))
        ->toStartWith('https://ccrc.example.com/auth/callback?')
        ->not->toContain('evil.example.com');
});

it('chưa cấu hình callback_url thì không redirect ra ngoài', function () {
    config(['services.ccrc.callback_url' => null]);
    User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    Socialite::shouldReceive('driver->user')->andReturn(fakeCcrcSlackUser());
    session(['ccrc_oauth' => ['state' => 'STATE123']]);

    $response = $this->get('/auth/slack/callback');

    $response->assertRedirect(route('battlefield'));
    expect(IdeAccessToken::whereKind('one_time')->count())->toBe(0);
});

it('luồng IDE cũ không đổi', function () {
    User::factory()->create(['slack_user_id' => 'U01ABCDEF']);
    Socialite::shouldReceive('driver->user')->andReturn(fakeCcrcSlackUser());
    session(['ide_oauth' => ['state' => 'STATE123', 'client' => 'jetbrains']]);

    $response = $this->get('/auth/slack/callback');

    expect($response->headers->get('Location'))->toStartWith('jetbrains://phpstorm/token-slayer?');
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `./vendor/bin/pest tests/Feature/Auth/SlackCcrcFlowTest.php`
Expected: FAIL — `session('ccrc_oauth')` là null, callback đi thẳng về `battlefield`.

- [ ] **Step 3: Thêm config**

Trong `config/services.php`, thêm vào cuối mảng trả về (trước `];`):

```php
    'ccrc' => [
        // URL callback của hub CC Remote Control. CỐ ĐỊNH ở đây, không bao giờ
        // nhận từ query — xem redirectToCcrc() trong SlackController.
        'callback_url' => env('CCRC_CALLBACK_URL'),
    ],
```

- [ ] **Step 4: Thêm nhánh vào `SlackController::redirect()`**

Trong `app/Http/Controllers/Auth/SlackController.php`, thêm **ngay sau** khối `if ($request->query('return') === 'ide' …) { … }`:

```php
        if ($request->query('return') === 'ccrc' && is_string($state = $request->query('state'))) {
            // Chỉ cần `state`. Không có `client`, không có `redirect`: đích đến
            // của nhánh này đọc từ config, nên không có gì để nhận từ query.
            session()->put('ccrc_oauth', ['state' => $state]);
        }
```

- [ ] **Step 5: Thêm nhánh vào `SlackController::callback()` và hai helper**

Trong `callback()`, thêm **ngay sau** khối `if (($ide = $this->consumeIdeFlowState()) !== null) { … }`:

```php
        if (($ccrc = $this->consumeCcrcFlowState()) !== null) {
            return $this->redirectToCcrc($user, $ccrc['state']);
        }
```

Thêm hai method private (đặt cạnh `consumeIdeFlowState`/`redirectToIde`):

```php
    /**
     * @return array{state: string}|null
     */
    private function consumeCcrcFlowState(): ?array
    {
        $ccrc = session()->pull('ccrc_oauth');

        if (! is_array($ccrc) || ! isset($ccrc['state']) || ! is_string($ccrc['state'])) {
            return null;
        }

        return ['state' => $ccrc['state']];
    }

    private function redirectToCcrc(User $user, string $state): RedirectResponse
    {
        // KHÔNG nhận `redirect` từ query như nhánh IDE. Đích đến đọc từ config,
        // nên không tồn tại tham số nào để bẻ hướng. isLoopbackUrl() không áp
        // dụng được ở đây (hub không chạy trên loopback), nên thay vì nới lỏng
        // nó — hàm đó đang bịt đúng lỗ hổng này cho nhánh IDE — nhánh này bỏ
        // hẳn đầu vào động.
        $callback = config('services.ccrc.callback_url');

        if (! is_string($callback) || $callback === '') {
            // Fail-closed: chưa cấu hình thì tính năng không tồn tại, chứ
            // không phải redirect đi đâu đó.
            return redirect()->route('battlefield')
                ->with('error', 'CC Remote Control chưa được cấu hình trên máy chủ này.');
        }

        [$plain] = IdeAccessToken::issueOneTime($user, $state, 120);

        $separator = str_contains($callback, '?') ? '&' : '?';

        return redirect()->away(
            $callback.$separator.http_build_query(['token' => $plain, 'state' => $state])
        );
    }
```

- [ ] **Step 6: Chạy test để chắc chắn nó pass**

Run: `./vendor/bin/pest tests/Feature/Auth/SlackCcrcFlowTest.php`
Expected: PASS — 6 test xanh.

- [ ] **Step 7: Chạy toàn bộ test**

Run: `./vendor/bin/pest`
Expected: PASS. Đặc biệt `tests/Feature/Auth/SlackIdeFlowTest.php` và `IdeAuthRedirectTest.php` phải còn nguyên.

- [ ] **Step 8: Commit và mở PR**

```bash
git add config/services.php app/Http/Controllers/Auth/SlackController.php tests/Feature/Auth/SlackCcrcFlowTest.php
git commit -m "Add a ccrc branch to the Slack OAuth callback

The CCRC hub sends users here with return=ccrc and gets a one_time token
back at a callback URL read from config. Unlike the IDE branch it accepts
no redirect parameter at all: isLoopbackUrl() cannot cover a hub that is
not on loopback, and widening it would have loosened the IDE branch too.

Unconfigured means the branch does not exist, not that it redirects
somewhere."
git push -u origin feat/ccrc-identity-exchange
gh pr create --fill
```

Nói với reviewer hai câu này (spec §7.1, §7.2):
1. Đích redirect **không nhận đầu vào từ người dùng**, và chưa cấu hình thì **fail-closed**.
2. Không dùng lại `/api/ide/auth/exchange` vì nó trao quyền tạo session cho mọi user bằng một credential không có `expires_at`; endpoint mới chỉ trao một cái tên.

---

## Task 3: Shape mới cho `users.json`

**Repo này.** Từ đây trở đi làm ở `cc-remote-control`.

**Files:**
- Modify: `server/src/users.js`
- Test: `server/test/users.test.js:1-40` (mở rộng)

**Interfaces:**
- Consumes: `parseUsers(parsed, hubToken)` (đã có), `HUB_USER_NAME = 'admin'` (đã có)
- Produces:
  - `parseUsers` giờ trả user có thêm `displayName: string`
  - `upsertBySlackId(list: Array, slackUserId: string, displayName: string, newToken: string): {list: Array, token: string, created: boolean}`
  - `removeUser(list: Array, needle: string): {list: Array, removed: object|null, matches: Array}`

- [ ] **Step 1: Tạo branch**

```bash
git checkout -b feat/dang-nhap-slack
```

- [ ] **Step 2: Viết test thất bại**

Trước hết sửa dòng import sẵn có ở `server/test/users.test.js:8` (đừng thêm một dòng
`import` thứ hai từ cùng module):

```js
import { HUB_USER_NAME, parseUsers, removeUser, upsertBySlackId } from '../src/users.js';
```

Rồi thêm vào cuối file:

```js
// Tương thích ngược đứng TRƯỚC mọi thứ khác: users.json trên hub đang chạy
// toàn entry cũ, và một bản deploy làm chúng ngừng nạp là cả team mất
// thông báo cùng lúc.
test('entry cũ không có displayName vẫn nạp được, displayName lấy chính name', () => {
  const { users } = parseUsers([{ name: 'huy', token: 'tok-huy' }], HUB_TOKEN);
  assert.deepEqual(users.get('tok-huy'), { name: 'huy', displayName: 'huy', admin: false });
});

test('entry mới giữ nguyên displayName riêng', () => {
  const { users } = parseUsers([{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok' }], HUB_TOKEN);
  assert.deepEqual(users.get('tok'), { name: 'U01ABCDEF', displayName: 'huy', admin: false });
});

test('upsert lần đầu tạo entry mới với token được đưa vào', () => {
  const { list, token, created } = upsertBySlackId([], 'U01ABCDEF', 'huy', 'tok-moi');
  assert.equal(created, true);
  assert.equal(token, 'tok-moi');
  assert.deepEqual(list, [{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok-moi' }]);
});

test('upsert lần hai GIỮ NGUYÊN token cũ', () => {
  const first = upsertBySlackId([], 'U01ABCDEF', 'huy', 'tok-cu');
  const second = upsertBySlackId(first.list, 'U01ABCDEF', 'huy', 'tok-moi');
  assert.equal(second.created, false);
  assert.equal(second.token, 'tok-cu',
    'đổi token lúc đăng nhập lại là đá văng mọi thiết bị khác của chính người đó');
  assert.equal(second.list.length, 1, 'không được đẻ entry thứ hai');
});

test('đổi handle trên Slack chỉ đổi displayName, khoá và token đứng yên', () => {
  const first = upsertBySlackId([], 'U01ABCDEF', 'huy', 'tok-cu');
  const { list } = upsertBySlackId(first.list, 'U01ABCDEF', 'huy-moi', 'tok-khac');
  assert.deepEqual(list, [{ name: 'U01ABCDEF', displayName: 'huy-moi', token: 'tok-cu' }]);
});

test('upsert không đụng tới entry của người khác', () => {
  const base = [{ name: 'kien-cu', token: 'tok-kien' }];
  const { list } = upsertBySlackId(base, 'U01ABCDEF', 'huy', 'tok-huy');
  assert.deepEqual(list[0], { name: 'kien-cu', token: 'tok-kien' });
  assert.equal(list.length, 2);
});

test('removeUser xoá được bằng displayName', () => {
  const base = [{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok' }];
  const { list, removed } = removeUser(base, 'huy');
  assert.equal(removed.name, 'U01ABCDEF');
  assert.deepEqual(list, []);
});

test('removeUser xoá được bằng name (kể cả entry cũ)', () => {
  const base = [{ name: 'huy-cu', token: 'tok' }];
  const { list, removed } = removeUser(base, 'huy-cu');
  assert.equal(removed.name, 'huy-cu');
  assert.deepEqual(list, []);
});

test('trùng displayName thì KHÔNG xoá gì, trả về cả hai để người chạy tự chọn', () => {
  const base = [
    { name: 'U01', displayName: 'huy', token: 'a' },
    { name: 'U02', displayName: 'huy', token: 'b' },
  ];
  const { list, removed, matches } = removeUser(base, 'huy');
  assert.equal(removed, null, 'xoá nhầm người là mất push subs và phiên đang mở của họ');
  assert.equal(matches.length, 2);
  assert.equal(list.length, 2);
});

test('không khớp ai thì không xoá gì', () => {
  const base = [{ name: 'U01', displayName: 'huy', token: 'a' }];
  const { list, removed, matches } = removeUser(base, 'khong-co');
  assert.equal(removed, null);
  assert.equal(matches.length, 0);
  assert.equal(list.length, 1);
});
```

- [ ] **Step 3: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- --test-name-pattern="displayName|upsert|removeUser|trùng displayName|không khớp"`
Expected: FAIL — `upsertBySlackId is not a function`, và test tương thích ngược fail vì `parseUsers` chưa trả `displayName`.

- [ ] **Step 4: Sửa `parseUsers` và thêm hai hàm mới**

Trong `server/src/users.js`, sửa dòng `users.set(u.token, { name, admin: !!u.admin });` thành:

```js
    // displayName mặc định bằng name: users.json trên hub đang chạy toàn entry
    // cũ do `deploy.sh adduser` tạo, và chúng không có trường này. Không cần
    // migration file — chỉ cần đọc được cả hai hình.
    const displayName = typeof u.displayName === 'string' && u.displayName ? u.displayName : name;
    users.set(u.token, { name, displayName, admin: !!u.admin });
```

Thêm vào cuối file:

```js
/**
 * Thêm hoặc cập nhật entry theo slack_user_id. THUẦN: nhận mảng, trả mảng mới,
 * không đụng đĩa — index.js là nơi duy nhất đọc/ghi file.
 *
 * Token cũ được GIỮ NGUYÊN khi entry đã tồn tại. Đăng nhập lại trên điện thoại
 * mà đổi token là đá văng máy dev của chính người đó, và họ sẽ không hiểu vì
 * sao thông báo im bặt.
 *
 * @param {Array} list      nội dung users.json đã JSON.parse
 * @param {string} slackUserId  khoá bất biến (`name`)
 * @param {string} displayName  handle Slack, chỉ để hiển thị
 * @param {string} newToken     token dùng khi phải tạo mới
 * @returns {{list: Array, token: string, created: boolean}}
 */
export function upsertBySlackId(list, slackUserId, displayName, newToken) {
  const arr = Array.isArray(list) ? [...list] : [];
  const i = arr.findIndex((u) => u && typeof u === 'object' && u.name === slackUserId);

  if (i >= 0) {
    const token = arr[i].token;
    arr[i] = { ...arr[i], name: slackUserId, displayName, token };
    return { list: arr, token, created: false };
  }

  arr.push({ name: slackUserId, displayName, token: newToken });
  return { list: arr, token: newToken, created: true };
}

/**
 * Xoá một entry theo `name` HOẶC `displayName`.
 *
 * Khớp nhiều thì KHÔNG xoá gì và trả về danh sách khớp: lệnh này chạy lúc có
 * sự cố nhân sự, và xoá nhầm người là mất push subs, lịch sử và phiên đang mở
 * của họ. Thà bắt gõ lại bằng `name` còn hơn đoán.
 *
 * @param {Array} list
 * @param {string} needle
 * @returns {{list: Array, removed: object|null, matches: Array}}
 */
export function removeUser(list, needle) {
  const arr = Array.isArray(list) ? list : [];
  const matches = arr.filter(
    (u) => u && typeof u === 'object' && (u.name === needle || u.displayName === needle),
  );

  if (matches.length !== 1) return { list: arr, removed: null, matches };

  const removed = matches[0];
  return { list: arr.filter((u) => u !== removed), removed, matches };
}
```

- [ ] **Step 5: Chạy test để chắc chắn nó pass**

Run: `npm test --workspace server`
Expected: PASS toàn bộ 256+ test — đặc biệt `terminal-api.test.js` phải còn xanh (nó dựa vào `parseUsers`).

- [ ] **Step 6: Commit**

```bash
git add server/src/users.js server/test/users.test.js
git commit -m "Key users.json by slack_user_id with a separate display name

Slack handles change; the key everything on the hub hangs off must not.
Push subscriptions, notification history and open terminal sessions are
all keyed by name, so a rename that changes the key silently turns
someone into a different user.

Entries written by deploy.sh adduser carry no displayName, so it falls
back to name and they keep loading unchanged."
```

---

## Task 4: Kho one-shot có TTL (`oauth-state.js`)

**Files:**
- Create: `server/src/oauth-state.js`
- Test: `server/test/oauth-state.test.js`

**Interfaces:**
- Consumes: không
- Produces: `createOneShotStore({ttlMs: number, now?: () => number, bytes?: number}): {issue(payload: any): string, consume(code: any): any|null, size(): number}`

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/oauth-state.test.js`:

```js
// Kho one-shot dùng cho `state` của OAuth và `claimCode` trao token cho PWA.
//
// Cả hai đều là thứ đi qua thanh địa chỉ trình duyệt, tức là đi vào history,
// vào Referer, vào access log của reverse proxy. Chúng chỉ an toàn chừng nào
// dùng-một-lần và hết hạn là thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneShotStore } from '../src/oauth-state.js';

test('issue rồi consume trả lại đúng payload', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  const code = s.issue({ token: 'tok', displayName: 'huy' });
  assert.deepEqual(s.consume(code), { token: 'tok', displayName: 'huy' });
});

test('consume lần hai trả null — đây là toàn bộ lý do kho này tồn tại', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  const code = s.issue({ a: 1 });
  s.consume(code);
  assert.equal(s.consume(code), null);
});

test('quá TTL thì chết', () => {
  let t = 0;
  const s = createOneShotStore({ ttlMs: 1000, now: () => t });
  const code = s.issue({ a: 1 });
  t = 1001;
  assert.equal(s.consume(code), null);
});

test('còn trong TTL thì sống', () => {
  let t = 0;
  const s = createOneShotStore({ ttlMs: 1000, now: () => t });
  const code = s.issue({ a: 1 });
  t = 999;
  assert.deepEqual(s.consume(code), { a: 1 });
});

test('mã bịa ra không đổi được gì', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  s.issue({ a: 1 });
  assert.equal(s.consume('bia-dat'), null);
  assert.equal(s.consume(''), null);
  assert.equal(s.consume(undefined), null);
  assert.equal(s.consume(null), null);
  assert.equal(s.consume(123), null);
});

test('hai lần issue cho hai mã khác nhau', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  assert.notEqual(s.issue({}), s.issue({}));
});

test('entry hết hạn được dọn khỏi bộ nhớ, không chỉ bị từ chối', () => {
  let t = 0;
  const s = createOneShotStore({ ttlMs: 1000, now: () => t });
  s.issue({ a: 1 });
  s.issue({ a: 2 });
  assert.equal(s.size(), 2);
  t = 1001;
  assert.equal(s.size(), 0, 'không dọn thì một hub chạy lâu ngày là một chỗ rò bộ nhớ');
});

test('mã đủ dài để không đoán được', () => {
  const s = createOneShotStore({ ttlMs: 1000 });
  assert.ok(s.issue({}).length >= 40, 'base64url của 32 byte dài 43 ký tự');
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- --test-name-pattern="one-shot|TTL|payload"`
Expected: FAIL — `Cannot find module '../src/oauth-state.js'`.

- [ ] **Step 3: Viết module**

Tạo `server/src/oauth-state.js`:

```js
// Kho "cấp một mã, đổi đúng một lần, hết hạn thì thôi".
//
// Dùng cho hai thứ trong luồng đăng nhập Slack, cùng hình dạng nên cùng một
// module:
//
//   - `state` của OAuth (TTL 5 phút) — buộc callback phải thuộc về đúng lần
//     bấm "Đăng nhập" này, không phải một link ai đó gửi tới.
//   - `claimCode` (TTL 60 giây) — thứ đi qua `?login=` trên thanh địa chỉ để
//     trao token cho PWA. Token của hub sống mãi, mà URL thì đi vào history
//     trình duyệt, vào Referer, và vào access log của reverse proxy đứng
//     trước hub. Một secret vĩnh viễn không được đi qua ba chỗ đó; một mã
//     sống 60 giây và dùng một lần thì lọt ra ngoài cũng đã chết.
//
// Trong RAM, hệt như pairing.js và terminal-sessions.js: thứ sống lâu nhất ở
// đây là năm phút, nên hub khởi động lại chỉ có nghĩa là bấm lại.

import crypto from 'node:crypto';

/**
 * @param {{ttlMs: number, now?: () => number, bytes?: number}} opts
 */
export function createOneShotStore(opts) {
  const { ttlMs, now = () => Date.now(), bytes = 32 } = opts || {};
  /** @type {Map<string, {payload: any, at: number}>} */
  const byCode = new Map();

  // Dọn lười từ mọi lối vào, cùng khuôn mẫu với pairing.js: một entry hết hạn
  // chỉ quan trọng vào lúc có người nhìn nó, và nhìn chính là lúc này. Nhờ vậy
  // toàn bộ thời gian bị `now` tiêm điều khiển và test không phải chờ thật.
  function prune() {
    const t = now();
    for (const [c, e] of byCode) if (t - e.at > ttlMs) byCode.delete(c);
  }

  return {
    issue(payload) {
      prune();
      const code = crypto.randomBytes(bytes).toString('base64url');
      byCode.set(code, { payload, at: now() });
      return code;
    },

    consume(code) {
      prune();
      if (typeof code !== 'string' || !code) return null;
      const e = byCode.get(code);
      if (!e) return null;
      // Xoá TRƯỚC khi trả: giữa hai lời gọi này không được có await nào, và
      // cách chắc chắn nhất là không có gì nằm giữa.
      byCode.delete(code);
      return e.payload;
    },

    size() {
      prune();
      return byCode.size;
    },
  };
}
```

- [ ] **Step 4: Chạy test để chắc chắn nó pass**

Run: `npm test --workspace server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/oauth-state.js server/test/oauth-state.test.js
git commit -m "Add a one-shot TTL store for OAuth state and claim codes

Both values travel through the browser address bar, which means browser
history, Referer headers and the reverse proxy's access log. Single use
plus a short expiry is what makes that survivable."
```

---

## Task 5: Vòng đời device-code (`device-code.js`)

**Files:**
- Create: `server/src/device-code.js`
- Test: `server/test/device-code.test.js`

**Interfaces:**
- Consumes: không
- Produces:
  - Hằng: `DEVICE_TTL_MS = 600000`, `POLL_INTERVAL_S = 5`, `MAX_WRONG = 5`, `MAX_PENDING = 50`
  - `normalizeUserCode(raw: string): string`
  - `createDeviceCodes({now?, randomInt?}): {start(), approve(approverName, rawUserCode, grant), poll(deviceCode)}`
    - `start(): {ok: true, deviceCode, userCode, ttl, interval} | {ok: false, reason}`
    - `approve(approverName: string, rawUserCode: any, grant: {name, displayName, token}): {ok: true} | {ok: false, reason, remaining}`
    - `poll(deviceCode: any): {status: 'gone'} | {status: 'throttled', retryIn} | {status: 'pending'} | {status: 'ready', grant}`

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/device-code.test.js`:

```js
// Device-code cho máy dev: script in một mã ngắn, người duyệt gõ nó trên
// thiết bị đã đăng nhập, script đổi lấy token.
//
// Bất đối xứng ở đây là toàn bộ thiết kế: `userCode` ngắn để gõ được, nhưng
// thứ ĐỔI RA TOKEN là `deviceCode` 32 byte. Nếu `userCode` đổi được token thì
// tám ký tự đó là toàn bộ hàng rào (RFC 8628 tách hai thứ này vì đúng lý do
// đó).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_TTL_MS, MAX_PENDING, MAX_WRONG, POLL_INTERVAL_S,
  createDeviceCodes, normalizeUserCode,
} from '../src/device-code.js';

const GRANT = { name: 'U01ABCDEF', displayName: 'huy', token: 'tok-huy' };

// `now` tiêm được nên test không phải chờ thật; mặc định nhảy quá interval để
// poll không bị chặn nhịp.
function mk() {
  let t = 0;
  const d = createDeviceCodes({ now: () => t });
  return { d, tick: (s) => { t += s * 1000; }, at: (s) => { t = s * 1000; } };
}

test('happy path: start → approve → poll ra token', () => {
  const { d, tick } = mk();
  const s = d.start();
  assert.equal(s.ok, true);
  assert.equal(d.poll(s.deviceCode).status, 'pending');

  assert.deepEqual(d.approve('U01ABCDEF', s.userCode, GRANT), { ok: true });

  tick(POLL_INTERVAL_S);
  const p = d.poll(s.deviceCode);
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.grant, GRANT);
});

test('userCode KHÔNG đổi ra token được — chỉ deviceCode mới đổi được', () => {
  const { d, tick } = mk();
  const s = d.start();
  d.approve('U01ABCDEF', s.userCode, GRANT);
  tick(POLL_INTERVAL_S);
  assert.equal(d.poll(s.userCode).status, 'gone',
    'gõ userCode vào chỗ deviceCode phải vô dụng, không thì 8 ký tự là toàn bộ hàng rào');
});

test('poll xong một lần thì phiên chết, không đổi được lần hai', () => {
  const { d, tick } = mk();
  const s = d.start();
  d.approve('U01ABCDEF', s.userCode, GRANT);
  tick(POLL_INTERVAL_S);
  assert.equal(d.poll(s.deviceCode).status, 'ready');
  assert.equal(d.poll(s.deviceCode).status, 'gone');
});

test('poll nhanh hơn interval bị chặn nhịp', () => {
  const { d, tick } = mk();
  const s = d.start();
  assert.equal(d.poll(s.deviceCode).status, 'pending');
  tick(1);
  const p = d.poll(s.deviceCode);
  assert.equal(p.status, 'throttled');
  assert.ok(p.retryIn > 0);
});

test('quá TTL thì phiên chết', () => {
  const { d, at } = mk();
  const s = d.start();
  at(DEVICE_TTL_MS / 1000 + 1);
  assert.equal(d.poll(s.deviceCode).status, 'gone');
});

test('duyệt sau khi hết hạn thì không ăn thua', () => {
  const { d, at } = mk();
  const s = d.start();
  at(DEVICE_TTL_MS / 1000 + 1);
  assert.equal(d.approve('U01ABCDEF', s.userCode, GRANT).ok, false);
});

test('gõ sai đếm ngược, đủ MAX_WRONG thì khoá người duyệt đó', () => {
  const { d } = mk();
  const s = d.start();
  for (let i = 1; i < MAX_WRONG; i++) {
    const r = d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT);
    assert.equal(r.ok, false);
    assert.equal(r.remaining, MAX_WRONG - i);
  }
  assert.equal(d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT).remaining, 0);
  // Khoá rồi thì mã ĐÚNG cũng không dùng được nữa.
  assert.equal(d.approve('U01ABCDEF', s.userCode, GRANT).ok, false);
  assert.equal(d.poll(s.deviceCode).status, 'pending');
});

test('khoá chỉ áp cho người gõ sai, không lây sang người khác', () => {
  const { d } = mk();
  const s = d.start();
  for (let i = 0; i < MAX_WRONG; i++) d.approve('U-KE-XAU', 'ZZZZ-ZZZZ', GRANT);
  assert.equal(d.approve('U01ABCDEF', s.userCode, GRANT).ok, true);
});

test('gõ đúng thì bộ đếm sai được xoá', () => {
  const { d } = mk();
  const a = d.start();
  d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT);
  d.approve('U01ABCDEF', a.userCode, GRANT);
  const b = d.start();
  assert.equal(d.approve('U01ABCDEF', 'ZZZZ-ZZZZ', GRANT).remaining, MAX_WRONG - 1);
  assert.equal(d.approve('U01ABCDEF', b.userCode, GRANT).ok, true);
});

test('chạm trần phiên pending thì từ chối cấp thêm', () => {
  const { d } = mk();
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(d.start().ok, true);
  const over = d.start();
  assert.equal(over.ok, false);
  assert.match(over.reason, /quá nhiều/i);
});

test('phiên hết hạn nhả lại chỗ trong trần', () => {
  const { d, at } = mk();
  for (let i = 0; i < MAX_PENDING; i++) d.start();
  at(DEVICE_TTL_MS / 1000 + 1);
  assert.equal(d.start().ok, true);
});

test('userCode hiện ra dạng XXXX-XXXX và không chứa ký tự dễ đọc nhầm', () => {
  const { d } = mk();
  for (let i = 0; i < 50; i++) {
    const { userCode } = d.start();
    assert.match(userCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      `mã đọc từ màn hình laptop rồi gõ sang điện thoại: ${userCode}`);
    assert.ok(!/[ILOU]/.test(userCode), `còn ký tự dễ nhầm: ${userCode}`);
  }
});

test('gõ mã bằng chữ thường hoặc thiếu gạch vẫn nhận', () => {
  const { d } = mk();
  const s = d.start();
  const messy = s.userCode.toLowerCase().replace('-', ' ');
  assert.equal(d.approve('U01ABCDEF', messy, GRANT).ok, true);
});

test('normalizeUserCode chịu được đầu vào rác', () => {
  assert.equal(normalizeUserCode('k7m2-qx9f'), 'K7M2QX9F');
  assert.equal(normalizeUserCode('  K7M2 QX9F '), 'K7M2QX9F');
  assert.equal(normalizeUserCode(null), '');
  assert.equal(normalizeUserCode(42), '');
});

test('deviceCode bịa ra không lấy được gì', () => {
  const { d } = mk();
  d.start();
  assert.equal(d.poll('bia-dat').status, 'gone');
  assert.equal(d.poll(undefined).status, 'gone');
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- --test-name-pattern="device|userCode|deviceCode|normalizeUserCode"`
Expected: FAIL — `Cannot find module '../src/device-code.js'`.

- [ ] **Step 3: Viết module**

Tạo `server/src/device-code.js`:

```js
// Device-code cho máy dev, theo tinh thần RFC 8628.
//
// Máy dev chưa có gì để xác thực, nên nó không thể tự chứng minh mình là ai.
// Cách giải: nó xin một cặp mã, in cái NGẮN ra màn hình, và một thiết bị ĐÃ
// đăng nhập gõ mã đó để bảo hub "cấp token của tôi cho cái máy đang cầm mã
// này".
//
// Bất đối xứng là toàn bộ thiết kế:
//
//   userCode   8 ký tự  — để người gõ. KHÔNG đổi ra token được.
//   deviceCode 32 byte  — thứ duy nhất đổi ra token.
//
// Để userCode đổi được token thì tám ký tự đó là toàn bộ hàng rào, và
// brute-force xong trong vài phút. Cùng tinh thần cặp `pairId`/`sas` mà hub
// đã dùng cho ghép cặp thiết bị.
//
// Trong RAM như pairing.js: thứ sống lâu nhất là mười phút.

import crypto from 'node:crypto';

export const DEVICE_TTL_MS = 10 * 60_000;
export const POLL_INTERVAL_S = 5;
export const MAX_WRONG = 5;

// Trần phiên pending. `/api/device/start` không có auth — đúng bản chất, máy
// dev chưa có gì để xác thực — nên không có trần thì một kẻ gọi liên tục vừa
// ngốn RAM vừa làm loãng không gian userCode tới mức gõ trúng mã người khác
// trở thành chuyện có thật.
export const MAX_PENDING = 50;

// Crockford base32 bỏ I, L, O, U. Mã này được đọc từ màn hình laptop rồi gõ
// sang điện thoại; `0`/`O` và `1`/`I` lẫn nhau ở đó là một lần thử sai vô cớ.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;

/**
 * Chuẩn hoá thứ người dùng gõ vào: chấp nhận chữ thường, gạch nối, khoảng
 * trắng. Người gõ lại đúng thứ họ nhìn thấy đã đủ khó rồi.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUserCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function format(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * @param {{now?: () => number, randomInt?: (n: number) => number}} [opts]
 */
export function createDeviceCodes(opts) {
  const {
    now = () => Date.now(),
    randomInt = (n) => crypto.randomInt(n),
  } = opts || {};

  /** @type {Map<string, {userCode: string, grant: object|null, lastPollAt: number, at: number}>} */
  const byDevice = new Map();
  /** @type {Map<string, string>} userCode đã chuẩn hoá -> deviceCode */
  const byUserCode = new Map();
  /** @type {Map<string, {count: number, at: number}>} tên người duyệt -> số lần gõ sai */
  const wrongByApprover = new Map();

  function prune() {
    const t = now();
    for (const [dc, e] of byDevice) {
      if (t - e.at > DEVICE_TTL_MS) {
        byDevice.delete(dc);
        byUserCode.delete(e.userCode);
      }
    }
    for (const [who, w] of wrongByApprover) {
      if (t - w.at > DEVICE_TTL_MS) wrongByApprover.delete(who);
    }
  }

  function mintUserCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let s = '';
      for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randomInt(ALPHABET.length)];
      if (!byUserCode.has(s)) return s;
    }
    return null;
  }

  return {
    start() {
      prune();
      if (byDevice.size >= MAX_PENDING) {
        return { ok: false, reason: 'Đang có quá nhiều máy chờ duyệt — thử lại sau vài phút' };
      }
      const userCode = mintUserCode();
      if (userCode === null) {
        return { ok: false, reason: 'Đang có quá nhiều máy chờ duyệt — thử lại sau vài phút' };
      }
      const deviceCode = crypto.randomBytes(32).toString('base64url');
      byDevice.set(deviceCode, { userCode, grant: null, lastPollAt: 0, at: now() });
      byUserCode.set(userCode, deviceCode);
      return {
        ok: true,
        deviceCode,
        userCode: format(userCode),
        ttl: Math.floor(DEVICE_TTL_MS / 1000),
        interval: POLL_INTERVAL_S,
      };
    },

    /**
     * @param {string} approverName  tên người đang đăng nhập bấm duyệt
     * @param {unknown} rawUserCode  thứ họ gõ vào
     * @param {{name: string, displayName: string, token: string}} grant
     */
    approve(approverName, rawUserCode, grant) {
      prune();

      // Đếm sai theo NGƯỜI DUYỆT, không theo phiên: một mã sai không trỏ tới
      // phiên nào cả, nên không có phiên nào để đếm vào. Người duyệt thì đã
      // xác thực, nên đó là thứ duy nhất bám được.
      const w = wrongByApprover.get(approverName);
      if (w && w.count >= MAX_WRONG) {
        return { ok: false, reason: 'Sai quá nhiều lần — chờ vài phút rồi thử lại', remaining: 0 };
      }

      const code = normalizeUserCode(rawUserCode);
      const deviceCode = code ? byUserCode.get(code) : undefined;
      const entry = deviceCode ? byDevice.get(deviceCode) : undefined;

      if (!entry || entry.grant !== null) {
        const count = (w?.count || 0) + 1;
        wrongByApprover.set(approverName, { count, at: now() });
        const remaining = Math.max(0, MAX_WRONG - count);
        return {
          ok: false,
          reason: remaining > 0 ? `Sai mã (còn ${remaining} lần)` : 'Sai quá nhiều lần — chờ vài phút rồi thử lại',
          remaining,
        };
      }

      wrongByApprover.delete(approverName);
      entry.grant = grant;
      return { ok: true };
    },

    poll(deviceCode) {
      prune();
      if (typeof deviceCode !== 'string' || !deviceCode) return { status: 'gone' };
      const e = byDevice.get(deviceCode);
      if (!e) return { status: 'gone' };

      const t = now();
      if (e.lastPollAt && t - e.lastPollAt < POLL_INTERVAL_S * 1000) {
        return { status: 'throttled', retryIn: Math.ceil((POLL_INTERVAL_S * 1000 - (t - e.lastPollAt)) / 1000) };
      }
      e.lastPollAt = t;

      if (e.grant === null) return { status: 'pending' };

      // Đổi xong là phiên chết: token đã ra khỏi hub, giữ lại chỉ là một bản
      // sao nữa của cùng một secret.
      byDevice.delete(deviceCode);
      byUserCode.delete(e.userCode);
      return { status: 'ready', grant: e.grant };
    },
  };
}
```

- [ ] **Step 4: Chạy test để chắc chắn nó pass**

Run: `npm test --workspace server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/device-code.js server/test/device-code.test.js
git commit -m "Add device-code exchange for dev machines

A dev machine has nothing to authenticate with yet, so it prints a short
code that an already-signed-in device approves. The short code is only
ever typed by a human: what actually buys the token is a 32-byte device
code, because eight characters cannot be the whole fence."
```

---

## Task 6: Client gọi token-slayer (`identity.js`)

**Files:**
- Create: `server/src/identity.js`
- Test: `server/test/identity.test.js`

**Interfaces:**
- Consumes: endpoint từ Task 1
- Produces: `createIdentity({internalUrl: string, fetchImpl?: Function, timeoutMs?: number}): {exchange(token: string, state: string): Promise<{ok: true, slackUserId: string, handle: string} | {ok: false, status: number, reason: string}>}`
  - `reason` ∈ `'unreachable' | 'rejected' | 'bad_json' | 'no_identity'`

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/identity.test.js`:

```js
// Chỗ DUY NHẤT trong hub biết token-slayer tồn tại.
//
// Biên giới này có chủ đích: chọn đi qua token-slayer là ràng buộc tổ chức
// (quyền sửa Slack app), không phải ràng buộc kiến trúc. Đổi ý sau này thì
// chỉ file này bị thay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '../src/identity.js';

const INTERNAL = 'http://token-slayer';

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return impl(url, opts); };
  fn.calls = calls;
  return fn;
}

const ok = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('đổi được token lấy danh tính', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01ABCDEF', handle: 'huy' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.deepEqual(await id.exchange('tok', 'st'), { ok: true, slackUserId: 'U01ABCDEF', handle: 'huy' });
});

test('gọi vào URL NỘI BỘ, không phải URL công khai', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01', handle: 'h' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  await id.exchange('tok', 'st');
  assert.equal(f.calls[0].url, 'http://token-slayer/api/ccrc/auth/exchange',
    'đi ra internet là lộ luồng đăng nhập nội bộ ra ngoài một cách vô cớ');
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { token: 'tok', state: 'st' });
});

test('410 → rejected, không phải unreachable', async () => {
  const f = fakeFetch(() => new Response('{"error":"token_invalid_or_expired"}', { status: 410 }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  const r = await id.exchange('tok', 'st');
  assert.equal(r.ok, false);
  assert.equal(r.status, 410);
  assert.equal(r.reason, 'rejected');
});

test('token-slayer không với tới được → unreachable', async () => {
  const f = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  const r = await id.exchange('tok', 'st');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.status, 0);
});

test('trả JSON hỏng → bad_json, không ném', async () => {
  const f = fakeFetch(() => new Response('<html>502</html>', {
    status: 200, headers: { 'content-type': 'text/html' },
  }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.equal((await id.exchange('tok', 'st')).reason, 'bad_json');
});

test('thiếu slackUserId → no_identity, TUYỆT ĐỐI không đoán', async () => {
  const f = fakeFetch(() => ok({ handle: 'huy' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.equal((await id.exchange('tok', 'st')).reason, 'no_identity',
    'tạo user từ một danh tính rỗng là gắn token hợp lệ vào sai người');
});

test('slackUserId rỗng hoặc toàn khoảng trắng cũng là no_identity', async () => {
  for (const bad of ['', '   ', null, 42]) {
    const f = fakeFetch(() => ok({ slackUserId: bad, handle: 'huy' }));
    const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
    assert.equal((await id.exchange('tok', 'st')).reason, 'no_identity', `với ${JSON.stringify(bad)}`);
  }
});

test('thiếu handle thì lấy slackUserId làm nhãn, không chết', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01ABCDEF' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f });
  assert.deepEqual(await id.exchange('tok', 'st'),
    { ok: true, slackUserId: 'U01ABCDEF', handle: 'U01ABCDEF' });
});

test('có đặt timeout', async () => {
  const f = fakeFetch(() => ok({ slackUserId: 'U01', handle: 'h' }));
  const id = createIdentity({ internalUrl: INTERNAL, fetchImpl: f, timeoutMs: 5000 });
  await id.exchange('tok', 'st');
  assert.ok(f.calls[0].opts.signal, 'không có timeout thì một token-slayer treo làm treo luôn hub');
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- --test-name-pattern="danh tính|unreachable|no_identity|NỘI BỘ"`
Expected: FAIL — `Cannot find module '../src/identity.js'`.

- [ ] **Step 3: Viết module**

Tạo `server/src/identity.js`:

```js
// Chỗ DUY NHẤT trong hub biết token-slayer tồn tại.
//
// Hub đổi một `one_time` token lấy DANH TÍNH, và không gì khác. Cố ý không đi
// qua `/api/ide/auth/exchange`: cái đó trả về một bearer không có `expires_at`
// bearer đó sống lâu hơn và với xa hơn thứ luồng này cần. Hub chỉ cần biết TÊN, nên nó
// không được cầm thứ mạnh hơn thế — và nhờ vậy quan hệ hub ↔ token-slayer giữ
// được MỘT CHIỀU: hub hỏi, token-slayer trả lời.
//
// Biên giới này cũng là điểm cắt: chọn đi qua token-slayer thay vì nói thẳng
// với Slack là ràng buộc tổ chức (quyền sửa Slack app của workspace), không
// phải ràng buộc kiến trúc. Đổi ý thì chỉ file này bị thay.

const PATH = '/api/ccrc/auth/exchange';

/**
 * @param {{internalUrl: string, fetchImpl?: Function, timeoutMs?: number}} opts
 */
export function createIdentity(opts) {
  const { internalUrl, fetchImpl = fetch, timeoutMs = 5000 } = opts || {};

  return {
    /**
     * @returns {Promise<{ok: true, slackUserId: string, handle: string}
     *                 | {ok: false, status: number, reason: string}>}
     */
    async exchange(token, state) {
      // URL nội bộ trong docker network. Đi ra internet là phơi luồng đăng
      // nhập của cả team ra ngoài một cách vô cớ.
      const url = new URL(PATH, internalUrl).toString();

      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ token, state }),
          // Không có timeout thì một token-slayer treo làm treo luôn request
          // đăng nhập của hub, và Express không có gì cứu nó.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, status: 0, reason: 'unreachable' };
      }

      if (!res.ok) return { ok: false, status: res.status, reason: 'rejected' };

      let body;
      try {
        body = await res.json();
      } catch {
        return { ok: false, status: res.status, reason: 'bad_json' };
      }

      const slackUserId = typeof body?.slackUserId === 'string' ? body.slackUserId.trim() : '';
      // Không đoán. Tạo user từ một danh tính rỗng là gắn một token hợp lệ vào
      // sai người — hỏng tệ hơn hẳn một lần đăng nhập thất bại.
      if (!slackUserId) return { ok: false, status: res.status, reason: 'no_identity' };

      const rawHandle = typeof body?.handle === 'string' ? body.handle.trim() : '';
      return { ok: true, slackUserId, handle: rawHandle || slackUserId };
    },
  };
}
```

- [ ] **Step 4: Chạy test để chắc chắn nó pass**

Run: `npm test --workspace server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/identity.js server/test/identity.test.js
git commit -m "Add the one file that knows token-slayer exists

Exchanges a one_time token for an identity over the internal docker
network. Deliberately not the IDE bearer path: that returns a credential
far broader and longer-lived than this flow needs, and the hub only ever needs a name.

Keeping it to one call also keeps hub -> token-slayer trust one-way."
```

---

## Task 7: Route đăng nhập Slack trên hub

**Files:**
- Modify: `server/src/index.js:6-16` (imports), `server/src/index.js:52-72` (ghi users.json), sau `server/src/index.js:225`
- Test: `server/test/auth-flow.test.js`

**Interfaces:**
- Consumes: `createIdentity` (Task 6), `createOneShotStore` (Task 4), `upsertBySlackId` (Task 3), `HUB_USER_NAME`, `loadUsers()` và `USERS_FILE` (đã có trong index.js)
- Produces:
  - `GET /api/auth/config` → `{slackLogin: boolean}`
  - `GET /auth/start` → 302 sang token-slayer, hoặc 503 khi chưa cấu hình
  - `GET /auth/callback?token&state` → 302 `/?login=<claimCode>`, hoặc trang lỗi tĩnh
  - `POST /api/auth/claim {code}` → `{ok, token, displayName}` | 410

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/auth-flow.test.js`:

```js
// Luồng đăng nhập Slack, qua HTTP thật — khuôn `terminal-api.test.js`.
//
// Ở đây có một token vĩnh viễn đi qua trình duyệt, nên thứ đáng test nhất
// không phải "đăng nhập được không" mà là: token KHÔNG bao giờ nằm trong URL,
// `state` không dùng lại được, và không có lỗi nào để lại users.json ghi dở.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// token-slayer giả: trả đúng thứ endpoint thật trả, và ghi lại nó nhận được gì.
async function startFakeTs(handler) {
  const port = await freePort();
  const { createServer } = await import('node:http');
  const calls = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const { status, json } = handler(JSON.parse(body || '{}'));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, calls, stop: () => srv.close() };
}

async function startHub(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-auth-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([]));
  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: {
      ...process.env,
      CCRC_DATA_DIR: dataDir,
      CCRC_PORT: String(port),
      CCRC_TOKEN: 'admin-tok',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let died = null;
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });
  proc.once('exit', (code) => { died = `hub thoát sớm (code=${code})`; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (died) throw new Error(`${died}\n${stderr}`);
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const usersFile = path.join(dataDir, 'users.json');
  return {
    base,
    stop: () => proc.kill(),
    users: () => JSON.parse(fs.readFileSync(usersFile, 'utf8')),
  };
}

const okIdentity = () => ({ status: 200, json: { slackUserId: 'U01ABCDEF', handle: 'huy' } });

test('chưa cấu hình thì không có nút Slack và /auth/start từ chối', async () => {
  const hub = await startHub();
  try {
    const cfg = await (await fetch(hub.base + '/api/auth/config')).json();
    assert.equal(cfg.slackLogin, false);
    const r = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    assert.equal(r.status, 503);
  } finally { hub.stop(); }
});

test('/auth/start redirect sang token-slayer kèm return=ccrc và state', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com',
    CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const r = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://ts.example.com/auth/slack');
    assert.equal(loc.searchParams.get('return'), 'ccrc');
    assert.ok(loc.searchParams.get('state').length >= 40);
  } finally { hub.stop(); ts.stop(); }
});

test('callback tạo user rồi trả claimCode — TOKEN KHÔNG nằm trong URL', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com',
    CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const start = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');

    const cb = await fetch(`${hub.base}/auth/callback?token=one-time&state=${state}`, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    const loc = cb.headers.get('location');
    assert.match(loc, /^\/\?login=/);

    const users = hub.users();
    assert.equal(users.length, 1);
    assert.equal(users[0].name, 'U01ABCDEF');
    assert.equal(users[0].displayName, 'huy');
    assert.ok(!loc.includes(users[0].token), 'token vĩnh viễn không được đi qua thanh địa chỉ');

    const code = new URL(loc, hub.base).searchParams.get('login');
    const claim = await (await fetch(hub.base + '/api/auth/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json();
    assert.equal(claim.token, users[0].token);
    assert.equal(claim.displayName, 'huy');
  } finally { hub.stop(); ts.stop(); }
});

test('claimCode dùng một lần', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const start = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await fetch(`${hub.base}/auth/callback?token=t&state=${state}`, { redirect: 'manual' });
    const code = new URL(cb.headers.get('location'), hub.base).searchParams.get('login');

    const body = { code };
    const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    assert.equal((await fetch(hub.base + '/api/auth/claim', opts)).status, 200);
    assert.equal((await fetch(hub.base + '/api/auth/claim', opts)).status, 410);
  } finally { hub.stop(); ts.stop(); }
});

test('state dùng lại bị chặn', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const start = await fetch(hub.base + '/auth/start', { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    await fetch(`${hub.base}/auth/callback?token=t&state=${state}`, { redirect: 'manual' });
    const again = await fetch(`${hub.base}/auth/callback?token=t&state=${state}`, { redirect: 'manual' });
    assert.equal(again.status, 400);
  } finally { hub.stop(); ts.stop(); }
});

test('state bịa ra bị chặn, và KHÔNG hỏi token-slayer', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const r = await fetch(`${hub.base}/auth/callback?token=t&state=bia-dat`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.equal(ts.calls.length, 0);
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); ts.stop(); }
});

test('đăng nhập lần hai KHÔNG đổi token và KHÔNG đẻ entry mới', async () => {
  const ts = await startFakeTs(okIdentity);
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const login = async () => {
      const s = new URL((await fetch(hub.base + '/auth/start', { redirect: 'manual' }))
        .headers.get('location')).searchParams.get('state');
      await fetch(`${hub.base}/auth/callback?token=t&state=${s}`, { redirect: 'manual' });
    };
    await login();
    const first = hub.users()[0].token;
    await login();
    assert.equal(hub.users().length, 1);
    assert.equal(hub.users()[0].token, first);
  } finally { hub.stop(); ts.stop(); }
});

test('token-slayer trả 410 → không ghi users.json', async () => {
  const ts = await startFakeTs(() => ({ status: 410, json: { error: 'token_invalid_or_expired' } }));
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const s = new URL((await fetch(hub.base + '/auth/start', { redirect: 'manual' }))
      .headers.get('location')).searchParams.get('state');
    const r = await fetch(`${hub.base}/auth/callback?token=t&state=${s}`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); ts.stop(); }
});

test('token-slayer chết → 503, và nói rõ token cũ vẫn dùng được', async () => {
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com',
    CCRC_TS_INTERNAL_URL: 'http://127.0.0.1:1',
  });
  try {
    const s = new URL((await fetch(hub.base + '/auth/start', { redirect: 'manual' }))
      .headers.get('location')).searchParams.get('state');
    const r = await fetch(`${hub.base}/auth/callback?token=t&state=${s}`, { redirect: 'manual' });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /vẫn dùng/i);
    assert.deepEqual(hub.users(), []);
  } finally { hub.stop(); }
});

test('danh tính tên "admin" bị từ chối', async () => {
  const ts = await startFakeTs(() => ({ status: 200, json: { slackUserId: 'admin', handle: 'admin' } }));
  const hub = await startHub({
    CCRC_TS_PUBLIC_URL: 'https://ts.example.com', CCRC_TS_INTERNAL_URL: ts.base,
  });
  try {
    const s = new URL((await fetch(hub.base + '/auth/start', { redirect: 'manual' }))
      .headers.get('location')).searchParams.get('state');
    const r = await fetch(`${hub.base}/auth/callback?token=t&state=${s}`, { redirect: 'manual' });
    assert.equal(r.status, 400);
    assert.deepEqual(hub.users(), [], "'admin' là chìa thứ hai vào hộp của chủ hub");
  } finally { hub.stop(); ts.stop(); }
});

test('trang lỗi KHÔNG tự redirect — nó có nút bấm', async () => {
  const hub = await startHub();
  try {
    const r = await fetch(hub.base + '/auth/callback?token=t&state=x', { redirect: 'manual' });
    assert.ok(r.status >= 400);
    assert.equal(r.headers.get('location'), null,
      'token-slayer từng ping-pong vô hạn vì lỗi tự redirect lại — đừng lặp lại');
    assert.match(await r.text(), /<a href="\/"/);
  } finally { hub.stop(); }
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- test/auth-flow.test.js`
Expected: FAIL — `/api/auth/config` trả 404.

- [ ] **Step 3: Thêm import vào `index.js`**

Sửa khối import ở đầu `server/src/index.js` (dòng 6–16), thêm 4 dòng:

```js
import crypto from 'node:crypto';
```
(đặt sau `import express from 'express';`)

```js
import { HUB_USER_NAME, parseUsers, upsertBySlackId } from './users.js';
```
(thay dòng import users.js đang có)

```js
import { createIdentity } from './identity.js';
import { createOneShotStore } from './oauth-state.js';
```
(đặt sau `import { createPairings } from './pairing.js';`)

- [ ] **Step 4: Thêm cấu hình và helper ghi file**

Thêm **ngay sau** `fs.watchFile(USERS_FILE, { interval: 5000 }, loadUsers);` (dòng 68):

```js
// --- Đăng nhập bằng Slack, danh tính lấy qua token-slayer -------------------
//
// Hai URL tách bạch và KHÔNG dùng lẫn: PUBLIC là thứ dán vào redirect cho
// trình duyệt đi, INTERNAL là thứ hub gọi trong docker network. Thiếu một
// trong hai thì tính năng không tồn tại — fail-closed, chứ không phải gọi
// vào một địa chỉ đoán được.
const TS_PUBLIC_URL = process.env.CCRC_TS_PUBLIC_URL || '';
const TS_INTERNAL_URL = process.env.CCRC_TS_INTERNAL_URL || '';
const slackLoginEnabled = !!(TS_PUBLIC_URL && TS_INTERNAL_URL);

const identity = createIdentity({ internalUrl: TS_INTERNAL_URL });
const oauthStates = createOneShotStore({ ttlMs: 5 * 60_000 });
const loginClaims = createOneShotStore({ ttlMs: 60_000 });

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Ghi entry cho một danh tính Slack rồi nạp lại ngay. Trả token của người đó,
 * hoặc null nếu không ghi được.
 *
 * Ghi qua temp + rename như devices.js: một users.json cụt vì mất điện giữa
 * chừng là cả team mất quyền cùng lúc. Gọi loadUsers() luôn thay vì chờ
 * watchFile 5 giây — người dùng đang đứng nhìn màn hình.
 */
function saveSlackUser(slackUserId, displayName) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { list = []; }
  if (!Array.isArray(list)) list = [];

  const { list: next, token } = upsertBySlackId(list, slackUserId, displayName, genToken());
  const tmp = `${USERS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, USERS_FILE);
  } catch (e) {
    console.error('[hub] không ghi được users.json:', e.message);
    return null;
  }
  loadUsers();
  return token;
}
```

- [ ] **Step 5: Thêm trang lỗi và các route**

Thêm **ngay sau** `app.get('/api/vapid-key', …)` (dòng 225):

```js
// --- Đăng nhập bằng Slack ---------------------------------------------------

// Trang lỗi TĨNH, có nút bấm, KHÔNG tự redirect.
//
// token-slayer đã phải thêm một cờ RETRY_FLAG vì callback hỏng của nó tự
// redirect lại /auth/slack, và một session hỏng vĩnh viễn thì ping-pong vô
// hạn. Không lặp lại: mọi lỗi trong luồng này dừng ở đây.
function authError(res, code, msg) {
  res.status(code).type('html').send(
    '<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<style>body{font:16px/1.5 system-ui;background:#0f1115;color:#e6e6e6;'
    + 'margin:0;display:grid;place-items:center;height:100vh;padding:24px;text-align:center}'
    + 'a{color:#7aa2f7}</style>'
    + `<div><p>${msg}</p><p><a href="/">Quay lại đăng nhập</a></p></div>`,
  );
}

app.get('/api/auth/config', (_req, res) => res.json({ slackLogin: slackLoginEnabled }));

app.get('/auth/start', (_req, res) => {
  if (!slackLoginEnabled) {
    return authError(res, 503, 'Đăng nhập bằng Slack chưa được cấu hình trên hub này.');
  }
  const state = oauthStates.issue({});
  const u = new URL('/auth/slack', TS_PUBLIC_URL);
  u.searchParams.set('return', 'ccrc');
  u.searchParams.set('state', state);
  res.redirect(302, u.toString());
});

app.get('/auth/callback', async (req, res) => {
  if (!slackLoginEnabled) {
    return authError(res, 503, 'Đăng nhập bằng Slack chưa được cấu hình trên hub này.');
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  // Tiêu huỷ state TRƯỚC khi hỏi token-slayer: một callback replay không được
  // phép tiêu tốn thêm một lượt nào nữa, kể cả một lượt thất bại.
  if (oauthStates.consume(state) === null) {
    return authError(res, 400, 'Phiên đăng nhập hết hạn hoặc đã dùng rồi.');
  }

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const r = await identity.exchange(token, state);

  if (!r.ok) {
    if (r.reason === 'unreachable') {
      return authError(res, 503,
        'Không liên lạc được token-slayer. Token đã cài trên máy vẫn dùng bình thường — chỉ đăng nhập mới hỏng.');
    }
    if (r.status === 410) {
      return authError(res, 400, 'Link đăng nhập đã dùng rồi hoặc quá 2 phút — thử lại.');
    }
    return authError(res, 400, 'Không lấy được danh tính Slack.');
  }

  // 'admin' là tên hub tự gán cho CCRC_TOKEN, và mọi state trên hub khoá theo
  // TÊN. parseUsers đã loại entry như vậy khi nạp; chặn ở đây để không phát ra
  // một token mà đầu bên kia không bao giờ dùng được.
  if (r.slackUserId === HUB_USER_NAME) {
    console.error(`[hub] từ chối danh tính Slack trùng tên dành riêng '${HUB_USER_NAME}'`);
    return authError(res, 400, 'Không lấy được danh tính Slack.');
  }

  const hubToken = saveSlackUser(r.slackUserId, r.handle);
  if (!hubToken) return authError(res, 500, 'Hub không ghi được cấu hình người dùng.');

  // Token đi qua claimCode chứ không qua URL: token của hub sống mãi, mà URL
  // đi vào history trình duyệt, vào Referer và vào access log của reverse
  // proxy. claimCode sống 60 giây và dùng một lần.
  const code = loginClaims.issue({ token: hubToken, displayName: r.handle });
  res.redirect(302, `/?login=${encodeURIComponent(code)}`);
});

app.post('/api/auth/claim', express.json({ limit: '4kb' }), (req, res) => {
  const p = loginClaims.consume(req.body?.code);
  if (!p) return res.status(410).json({ ok: false, error: 'Đăng nhập hết hạn, thử lại' });
  res.json({ ok: true, token: p.token, displayName: p.displayName });
});
```

- [ ] **Step 6: Chạy test để chắc chắn nó pass**

Run: `npm test --workspace server -- test/auth-flow.test.js`
Expected: PASS — 11 test xanh.

- [ ] **Step 7: Chạy toàn bộ test hub**

Run: `npm test --workspace server`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/index.js server/test/auth-flow.test.js
git commit -m "Wire the Slack login flow into the hub

State is consumed before token-slayer is asked anything, so a replayed
callback cannot spend another attempt. The hub token reaches the PWA
through a 60-second single-use claim code rather than the query string,
because a permanent secret must not enter browser history, Referer
headers or the proxy access log.

Every failure stops on a static page with a link. token-slayer needed a
retry flag because its own broken callback redirected back into the
flow and ping-ponged forever."
```

---

## Task 8: Route device-code trên hub

**Files:**
- Modify: `server/src/index.js` (imports + route sau `/api/auth/claim`)
- Test: `server/test/device-api.test.js`

**Interfaces:**
- Consumes: `createDeviceCodes` (Task 5), `requireUser(req, res)` (đã có, `server/src/index.js:132`)
- Produces:
  - `POST /api/device/start` → `{ok, deviceCode, userCode, ttl, interval}` | 429
  - `POST /api/device/poll {deviceCode}` → 200 `{ok, token, displayName}` | 428 | 429 | 410
  - `POST /api/device/approve {userCode}` (Bearer) → `{ok}` | 400 `{error, remaining}`
  - `GET /link` → phục vụ `public/index.html`

- [ ] **Step 1: Viết test thất bại**

Tạo `server/test/device-api.test.js`:

```js
// Device-code qua HTTP thật. Cùng khuôn startHub với terminal-api.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startHub() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccrc-dev-'));
  fs.writeFileSync(path.join(dataDir, 'users.json'),
    JSON.stringify([{ name: 'U01ABCDEF', displayName: 'huy', token: 'tok-huy' }]));
  const port = await freePort();
  const proc = spawn('node', [SRV], {
    env: { ...process.env, CCRC_DATA_DIR: dataDir, CCRC_PORT: String(port), CCRC_TOKEN: 'admin-tok' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, stop: () => proc.kill() };
}

const post = (base, p, body, token) => fetch(base + p, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  },
  body: JSON.stringify(body || {}),
});

// Duyệt TRƯỚC rồi mới poll lần đầu. Lần poll đầu không bị chặn nhịp
// (`lastPollAt` còn 0), nên test không phải ngủ 5 giây thật — POLL_INTERVAL_S
// nằm trong tiến trình hub nên không tiêm `now` vào được từ đây.
test('start → approve → poll ra đúng token của người duyệt', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    assert.ok(s.deviceCode && s.userCode);

    const ap = await post(hub.base, '/api/device/approve', { userCode: s.userCode }, 'tok-huy');
    assert.equal(ap.status, 200);

    const p = await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    assert.equal(p.status, 200);
    const body = await p.json();
    assert.equal(body.token, 'tok-huy');
    assert.equal(body.displayName, 'huy');
  } finally { hub.stop(); }
});

test('chưa duyệt thì poll trả 428', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    assert.equal((await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode })).status, 428);
  } finally { hub.stop(); }
});

test('approve KHÔNG có token thì 401', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    assert.equal((await post(hub.base, '/api/device/approve', { userCode: s.userCode })).status, 401);
  } finally { hub.stop(); }
});

test('deviceCode bịa ra → 410', async () => {
  const hub = await startHub();
  try {
    const r = await post(hub.base, '/api/device/poll', { deviceCode: 'bia-dat' });
    assert.equal(r.status, 410);
  } finally { hub.stop(); }
});

test('poll nhanh quá → 429', async () => {
  const hub = await startHub();
  try {
    const s = await (await post(hub.base, '/api/device/start')).json();
    await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    const r = await post(hub.base, '/api/device/poll', { deviceCode: s.deviceCode });
    assert.equal(r.status, 429);
  } finally { hub.stop(); }
});

test('gõ sai userCode trả về số lần còn lại', async () => {
  const hub = await startHub();
  try {
    await post(hub.base, '/api/device/start');
    const r = await post(hub.base, '/api/device/approve', { userCode: 'ZZZZ-ZZZZ' }, 'tok-huy');
    assert.equal(r.status, 400);
    assert.equal((await r.json()).remaining, 4);
  } finally { hub.stop(); }
});

test('GET /link phục vụ trang PWA chứ không 404', async () => {
  const hub = await startHub();
  try {
    const r = await fetch(hub.base + '/link');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<!DOCTYPE html>/i);
  } finally { hub.stop(); }
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- test/device-api.test.js`
Expected: FAIL — 404 ở `/api/device/start`.

- [ ] **Step 3: Thêm import và khởi tạo**

Trong `server/src/index.js`, thêm vào khối import:

```js
import { createDeviceCodes } from './device-code.js';
```

Thêm cạnh `const loginClaims = …` (Task 7):

```js
const deviceCodes = createDeviceCodes();
```

- [ ] **Step 4: Thêm route**

Thêm **ngay sau** `app.post('/api/auth/claim', …)`:

```js
// --- Device-code cho máy dev ------------------------------------------------

// Không có auth, đúng bản chất: máy dev chưa có gì để xác thực. Trần phiên
// pending nằm trong device-code.js là thứ giữ cho endpoint này không thành
// một cái vòi ngốn RAM.
app.post('/api/device/start', express.json({ limit: '4kb' }), (_req, res) => {
  const r = deviceCodes.start();
  if (!r.ok) return res.status(429).json({ ok: false, error: r.reason });
  res.json({ ok: true, deviceCode: r.deviceCode, userCode: r.userCode, ttl: r.ttl, interval: r.interval });
});

app.post('/api/device/poll', express.json({ limit: '4kb' }), (req, res) => {
  const r = deviceCodes.poll(req.body?.deviceCode);
  if (r.status === 'gone') return res.status(410).json({ ok: false, error: 'Mã đã hết hạn' });
  if (r.status === 'throttled') return res.status(429).json({ ok: false, retryIn: r.retryIn });
  if (r.status === 'pending') return res.status(428).json({ ok: false, error: 'Chưa được duyệt' });
  res.json({ ok: true, token: r.grant.token, displayName: r.grant.displayName });
});

app.post('/api/device/approve', express.json({ limit: '4kb' }), (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  // Token của chính người duyệt là thứ được trao đi — đó là ý nghĩa của việc
  // duyệt: "cấp quyền của TÔI cho cái máy đang cầm mã này".
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/, '').trim();
  const r = deviceCodes.approve(user.name, req.body?.userCode, {
    name: user.name, displayName: user.displayName, token: bearer,
  });
  if (!r.ok) return res.status(400).json({ ok: false, error: r.reason, remaining: r.remaining });
  res.json({ ok: true });
});

// Trang duyệt máy dev. Cùng index.html với PWA — app.js nhìn location.pathname
// để quyết định hiện thẻ nào, nên không có bundle thứ hai phải bảo trì.
app.get('/link', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
```

- [ ] **Step 5: Chạy test**

Run: `npm test --workspace server -- test/device-api.test.js`
Expected: PASS toàn bộ 7 test.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.js server/test/device-api.test.js
git commit -m "Add device-code endpoints and the /link approval page

start and poll are unauthenticated because a dev machine has nothing to
authenticate with yet; approve requires a bearer because what it hands
over is that user's own token."
```

---

## Task 9: PWA — nút Slack và trang duyệt

**Files:**
- Modify: `server/public/index.html:22-28`
- Modify: `server/public/app.js:1-40`, `server/public/app.js:1256`
- Test: `server/test/device-api.test.js` (thêm assertion markup vào test `/link`)

**Interfaces:**
- Consumes: `GET /api/auth/config`, `GET /auth/start`, `POST /api/auth/claim`, `POST /api/device/approve` (Task 7–8)
- Produces: phần tử DOM `#slack-login`, `#link-card`, `#link-code`, `#link-btn`, `#link-msg`, `#link-err`

- [ ] **Step 1: Sửa thẻ login trong `index.html`**

Thay khối `<div id="login" class="card">…</div>` (dòng 22–28) bằng:

```html
<div id="login" class="card">
  <h1>CC Notify</h1>
  <button id="slack-login" class="hidden">Đăng nhập bằng Slack</button>
  <p class="dim small" id="login-or">hoặc dán token cá nhân:</p>
  <input id="token" type="password" placeholder="Token cá nhân" autocomplete="off">
  <button id="login-btn">Đăng nhập</button>
  <p id="login-err" class="err hidden"></p>
</div>

<div id="link-card" class="card hidden">
  <h1>Duyệt máy dev</h1>
  <p class="dim">Nhập mã đang hiện trên terminal của máy dev.</p>
  <input id="link-code" type="text" placeholder="XXXX-XXXX" autocomplete="off"
         autocapitalize="characters" spellcheck="false">
  <button id="link-btn">Duyệt</button>
  <p id="link-msg" class="dim hidden"></p>
  <p id="link-err" class="err hidden"></p>
</div>
```

- [ ] **Step 2: Tăng `?v=` của stylesheet**

`index.html` dòng 20: đổi `style.css?v=10` thành `style.css?v=11`. PWA đã cài cache cả `index.html`, và ghi chú ngay trên dòng đó nói rõ phải bump.

- [ ] **Step 3: Thêm xử lý đăng nhập Slack vào `app.js`**

Thêm **ngay sau** hàm `logout()` (khoảng dòng 20):

```js
// Nút Slack chỉ hiện khi hub thực sự cấu hình được. Hỏi hub thay vì đoán:
// một nút dẫn tới 503 tệ hơn là không có nút.
(async () => {
  try {
    const { slackLogin } = await (await fetch('/api/auth/config')).json();
    if (slackLogin) $('slack-login').classList.remove('hidden');
    else $('login-or').classList.add('hidden');
  } catch {
    // Im lặng: ô dán token vẫn còn đó, người dùng vẫn vào được.
    $('login-or').classList.add('hidden');
  }
})();

$('slack-login').onclick = () => { location.href = '/auth/start'; };

// ?login=<claimCode> — đổi lấy token thật rồi xoá mã khỏi thanh địa chỉ.
async function consumeLoginCode() {
  const code = new URLSearchParams(location.search).get('login');
  if (!code) return false;
  // replaceState TRƯỚC await: nếu người dùng chia sẻ hay bookmark đúng lúc
  // request đang bay, cái họ cầm không được là một mã còn dùng được.
  history.replaceState(null, '', location.pathname);
  try {
    const res = await fetch('/api/auth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    if (!body.token) return false;
    token = body.token;
    localStorage.setItem('ccrc_token', token);
    return true;
  } catch {
    return false;
  }
}

// Trang /link: duyệt một máy dev đang chờ.
function showLink() {
  $('login').classList.add('hidden');
  $('main').classList.add('hidden');
  if (!token) { $('login').classList.remove('hidden'); return; }
  $('link-card').classList.remove('hidden');
}

$('link-btn').onclick = async () => {
  $('link-err').classList.add('hidden');
  $('link-msg').classList.add('hidden');
  const userCode = $('link-code').value.trim();
  if (!userCode) return;
  const res = await api('/api/device/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    $('link-msg').textContent = 'Đã duyệt. Quay lại terminal máy dev — nó tự nhận token trong vài giây.';
    $('link-msg').classList.remove('hidden');
    $('link-code').value = '';
    return;
  }
  $('link-err').textContent = body.error || 'Duyệt không thành công.';
  $('link-err').classList.remove('hidden');
};
```

- [ ] **Step 4: Thay dòng khởi động cuối `app.js`**

Thay dòng cuối (`server/public/app.js:1256`):

```js
if (token) showMain().catch(() => logout());
```

bằng:

```js
(async () => {
  if (location.pathname === '/link') { showLink(); return; }
  // Có ?login= thì phải đổi mã TRƯỚC, vì token trong localStorage (nếu có)
  // là của lần đăng nhập cũ.
  if (await consumeLoginCode()) { showMain().catch(() => logout()); return; }
  if (token) showMain().catch(() => logout());
})();
```

- [ ] **Step 5: Siết test `/link` cho nó kiểm cả markup**

Trong `server/test/device-api.test.js`, đổi assertion của test `GET /link phục vụ trang PWA
chứ không 404`:

```js
    assert.match(await r.text(), /<div id="link-card"/);
```

(thay dòng `assert.match(await r.text(), /<!DOCTYPE html>/i);` — giờ đã có thẻ thật để kiểm,
route phục vụ đúng trang chứ không chỉ phục vụ *một* trang nào đó)

- [ ] **Step 6: Chạy test**

Run: `npm test --workspace server -- test/device-api.test.js`
Expected: PASS toàn bộ 7 test.

- [ ] **Step 7: Chạy toàn bộ test hub**

Run: `npm test --workspace server`
Expected: PASS. `sw.test.js` và các test DOM (`app-*.test.js`) phải còn xanh — nếu đỏ thì `dom-harness.mjs` cần biết về phần tử mới, sửa ở đó.

- [ ] **Step 8: Commit**

```bash
git add server/public/index.html server/public/app.js server/test/device-api.test.js
git commit -m "Add a Slack login button and the dev-machine approval page

/link reuses index.html and switches on location.pathname, so there is
no second bundle to keep in sync. The claim code is stripped from the
address bar before the exchange request is awaited."
```

---

## Task 10: `setup-notify.sh` lấy token bằng device-code

**Files:**
- Modify: `setup-notify.sh:46-48`
- Test: `server/test/shell-scripts.test.js` (mở rộng)

**Interfaces:**
- Consumes: `POST /api/device/start`, `POST /api/device/poll` (Task 8)
- Produces: biến shell `DEVICE_TOKEN` do `device_code_login` đặt

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `server/test/shell-scripts.test.js`:

```js
// Device-code chạy trên máy người khác, nên cái sai ở đây không phải test đỏ
// mà là một người ngồi nhìn terminal treo.
test('setup-notify.sh có luồng device-code và DỪNG khi hub trả 410', () => {
  const src = read('setup-notify.sh');
  assert.match(src, /\/api\/device\/start/, 'phải xin được mã');
  assert.match(src, /\/api\/device\/poll/, 'phải poll được');
  assert.match(src, /410\)/,
    'không bắt 410 thì mã hết hạn xong script poll mãi tới hết deadline');
  assert.match(src, /428\|429\)/, 'chưa duyệt và poll nhanh quá đều là "chờ tiếp", không phải lỗi');
});

test('setup-notify.sh vẫn cho dán token tay khi device-code hỏng', () => {
  const src = read('setup-notify.sh');
  assert.match(src, /ask TOKEN/,
    'hub cũ hoặc mạng hỏng thì vẫn phải cài được — đừng bỏ đường lui');
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- --test-name-pattern="device-code"`
Expected: FAIL — chưa có `/api/device/start` trong script.

- [ ] **Step 3: Thêm hàm `device_code_login` vào `setup-notify.sh`**

Thêm **ngay trước** dòng `HUB_URL="${CCRC_HUB_URL:-}"` (khoảng dòng 41):

```bash
# Đọc một trường của JSON bằng node (script này đã đòi node ở trên).
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      try {
        const v = JSON.parse(s)[process.argv[1]];
        process.stdout.write(v == null ? "" : String(v));
      } catch { /* JSON hỏng = trường rỗng, người gọi tự xử */ }
    });
  ' "$1"
}

# Lấy token bằng device-code: in một mã ngắn, chờ người duyệt trên thiết bị đã
# đăng nhập, rồi đổi lấy token. Đặt DEVICE_TOKEN khi thành công.
#
# Mã ngắn CHỈ để người gõ; thứ đổi ra token là deviceCode 32 byte mà script
# này giữ. Không in deviceCode ra màn hình.
DEVICE_TOKEN=""
device_code_login() {
  local start dcode ucode ttl interval body code deadline
  start=$(curl -fsS -X POST "$HUB_URL/api/device/start" \
            -H 'content-type: application/json' -d '{}' 2>/dev/null) || return 1
  dcode=$(printf '%s' "$start" | json_field deviceCode)
  ucode=$(printf '%s' "$start" | json_field userCode)
  ttl=$(printf '%s' "$start" | json_field ttl)
  interval=$(printf '%s' "$start" | json_field interval)
  [ -n "$dcode" ] && [ -n "$ucode" ] || return 1
  [ -n "$ttl" ] || ttl=600
  [ -n "$interval" ] || interval=5

  say ""
  say "  Mở ${HUB_URL}/link trên thiết bị đã đăng nhập, rồi nhập mã:"
  say ""
  say "      ${ucode}"
  say ""
  say "  Đang chờ duyệt (tối đa ${ttl} giây)…"

  body=$(mktemp)
  deadline=$(( $(date +%s) + ttl ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep "$interval"
    code=$(curl -s -o "$body" -w '%{http_code}' -X POST "$HUB_URL/api/device/poll" \
             -H 'content-type: application/json' \
             -d "{\"deviceCode\":\"${dcode}\"}" 2>/dev/null) || code=000
    case "$code" in
      200)
        DEVICE_TOKEN=$(json_field token < "$body")
        rm -f "$body"
        [ -n "$DEVICE_TOKEN" ] || return 1
        say "  ✓ Đã nhận token."
        return 0
        ;;
      410)
        rm -f "$body"
        say "  ✗ Mã đã hết hạn."
        return 1
        ;;
      428|429) ;;   # chưa duyệt, hoặc poll nhanh quá — chờ tiếp
      *) ;;         # lỗi mạng tạm thời — chờ tiếp, deadline sẽ dừng vòng lặp
    esac
  done
  rm -f "$body"
  say "  ✗ Hết thời gian chờ duyệt."
  return 1
}
```

- [ ] **Step 4: Thay khối hỏi token**

Thay ba dòng hiện có (`setup-notify.sh:46-48`):

```bash
TOKEN="${CCRC_TOKEN:-}"
[ -n "$TOKEN" ] || ask TOKEN "Token cá nhân${OLD_TOK:+ [giữ nguyên]}: " "$OLD_TOK"
while [ -z "$TOKEN" ]; do ask TOKEN "Token cá nhân: " ""; done
```

bằng:

```bash
# Thứ tự: biến môi trường (installer truyền vào) → token đã cài lần trước →
# device-code → dán tay. Đường lui cuối cùng phải còn, vì một hub cũ chưa có
# /api/device/start vẫn phải cài được.
TOKEN="${CCRC_TOKEN:-$OLD_TOK}"
if [ -z "$TOKEN" ]; then
  device_code_login && TOKEN="$DEVICE_TOKEN"
fi
while [ -z "$TOKEN" ]; do ask TOKEN "Token cá nhân: " ""; done
```

- [ ] **Step 5: Kiểm tra cú pháp và chạy test**

Run: `bash -n setup-notify.sh && npm test --workspace server -- test/shell-scripts.test.js`
Expected: PASS — kể cả luật "không biến nào đứng ngay trước ký tự không phải ASCII" (mọi biến ở trên đều bọc `${}` khi đứng cạnh chữ tiếng Việt).

- [ ] **Step 6: Chạy toàn bộ test**

Run: `npm test`
Expected: PASS cả 3 workspace.

- [ ] **Step 7: Commit**

```bash
git add setup-notify.sh server/test/shell-scripts.test.js
git commit -m "Let setup-notify.sh fetch its token by device code

Prints a short code, waits for someone to approve it on an already
signed-in device, then writes the token. Manual paste stays as the last
fallback so an older hub without the endpoint can still be installed."
```

---

## Task 11: `deploy.sh deluser`

**Files:**
- Modify: `deploy.sh:14-17` (usage), `deploy.sh:31-72` (thêm `cmd_deluser`), `deploy.sh:73-77` (dispatch)
- Test: `server/test/shell-scripts.test.js` (mở rộng)

**Interfaces:**
- Consumes: `removeUser(list, needle)` từ `server/src/users.js` (Task 3), có trong image tại `/app/server/src/users.js`
- Produces: lệnh `./deploy.sh deluser <tên>`

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `server/test/shell-scripts.test.js`:

```js
test('deploy.sh có deluser và nó KHÔNG đoán khi khớp nhiều người', () => {
  const src = read('deploy.sh');
  assert.match(src, /cmd_deluser/);
  assert.match(src, /deluser\)/, 'phải có nhánh dispatch, không thì lệnh không gọi được');
  assert.match(src, /removeUser/, 'dùng lại luật trong users.js chứ không viết lại trong shell');
  assert.match(src, /matches\.length > 1/,
    'xoá nhầm người là mất push subs, lịch sử và phiên đang mở của họ');
});
```

- [ ] **Step 2: Chạy test để chắc chắn nó fail**

Run: `npm test --workspace server -- --test-name-pattern="deluser"`
Expected: FAIL — chưa có `cmd_deluser`.

- [ ] **Step 3: Cập nhật phần usage ở đầu file**

Trong `deploy.sh`, thêm sau dòng `#   ./deploy.sh adduser <tên>    # cấp token cho thành viên mới`:

```bash
#   ./deploy.sh deluser <tên>    # thu hồi token của một người
```

- [ ] **Step 4: Thêm `cmd_deluser`**

Thêm **ngay sau** hàm `cmd_adduser()` (sau dòng `}` đóng nó, khoảng dòng 60):

```bash
cmd_deluser() {
  local needle="${1:-}"
  [ -n "$needle" ] || { echo "Dùng: ./deploy.sh deluser <tên hiển thị hoặc slack_user_id>"; exit 1; }
  # Luật khớp nằm trong server/src/users.js, không viết lại ở đây: nó đã có
  # test, và hai bản sao của cùng một luật là hai bản sao sẽ lệch nhau.
  compose exec -T hub node --input-type=module -e '
    import fs from "node:fs";
    import { removeUser } from "/app/server/src/users.js";
    const f = "/data/users.json";
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    if (!Array.isArray(arr)) arr = [];
    const label = (u) => `${u.name}  (${u.displayName ?? u.name})`;
    const { list, removed, matches } = removeUser(arr, process.argv[1]);
    if (removed) {
      fs.writeFileSync(f, JSON.stringify(list, null, 2));
      console.log("OK " + label(removed));
      process.exit(0);
    }
    if (matches.length > 1) {
      console.error("Khớp nhiều người — gõ lại bằng cột đầu:");
      for (const m of matches) console.error("  " + label(m));
      process.exit(1);
    }
    console.error(`Không tìm thấy "${process.argv[1]}". Đang có:`);
    for (const u of arr) console.error("  " + label(u));
    process.exit(1);
  ' "$needle"
  echo "✅ Đã thu hồi. Hub tự nạp lại trong ~5s."
}
```

- [ ] **Step 5: Thêm nhánh dispatch**

Trong khối `case "${1:-deploy}" in`, thêm sau dòng `adduser) shift; cmd_adduser "$@"; exit 0 ;;`:

```bash
  deluser) shift; cmd_deluser "$@"; exit 0 ;;
```

Và sửa dòng lệnh không hợp lệ ở cuối `case` cho khớp:

```bash
  *) echo "Lệnh không hợp lệ: $1 (dùng: deploy | adduser <tên> | deluser <tên> | status | down)"; exit 1 ;;
```

- [ ] **Step 6: Kiểm tra cú pháp và chạy test**

Run: `bash -n deploy.sh && npm test --workspace server -- test/shell-scripts.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy.sh server/test/shell-scripts.test.js
git commit -m "Add deploy.sh deluser

Matches on display name or slack_user_id, and refuses to act when more
than one entry matches: this command runs during a personnel incident,
and deleting the wrong person costs them their push subscriptions,
history and open sessions."
```

---

## Task 12: Cấu hình, tài liệu và kiểm tra tại chỗ

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml:24-27`
- Modify: `README.md`
- Test: chạy thật bằng Docker

**Interfaces:**
- Consumes: mọi thứ từ Task 1–11
- Produces: `CCRC_TS_PUBLIC_URL`, `CCRC_TS_INTERNAL_URL` đi vào container hub

- [ ] **Step 1: Thêm biến vào `.env.example`**

Thêm vào cuối `.env.example`:

```bash
# --- Đăng nhập bằng Slack qua token-slayer (tuỳ chọn) ----------------------
# Thiếu MỘT trong hai thì tính năng tắt hẳn và PWA chỉ còn ô dán token.
#
# URL công khai của token-slayer — dán vào redirect cho TRÌNH DUYỆT đi.
#CCRC_TS_PUBLIC_URL=https://token-slayer.congty.vn
# URL nội bộ trong docker network — hub gọi thẳng, không ra internet.
#CCRC_TS_INTERNAL_URL=http://token-slayer
#
# Bên token-slayer nhớ đặt CCRC_CALLBACK_URL trỏ về hub, ví dụ:
#   CCRC_CALLBACK_URL=https://ccrc.congty.vn/auth/callback
```

- [ ] **Step 2: Truyền biến vào container**

Trong `docker-compose.yml`, thêm hai dòng vào `services.hub.environment`:

```yaml
      CCRC_TS_PUBLIC_URL: ${CCRC_TS_PUBLIC_URL:-}
      CCRC_TS_INTERNAL_URL: ${CCRC_TS_INTERNAL_URL:-}
```

- [ ] **Step 3: Cập nhật README**

Trong `README.md`, ở mục "### 1. Hub trên server", thêm sau dòng `./deploy.sh adduser ten-nguoi`:

```markdown
Có token-slayer chạy cùng server? Đặt `CCRC_TS_PUBLIC_URL` + `CCRC_TS_INTERNAL_URL`
trong `.env` (và `CCRC_CALLBACK_URL` bên token-slayer) là cả team tự đăng nhập bằng
Slack — không cần `adduser` cho từng người nữa. Máy dev thì `./setup-notify.sh` in một
mã ngắn, bạn duyệt trên điện thoại là nó tự nhận token.

Thu hồi khi có người rời team: `./deploy.sh deluser <tên>`. Hub **không** tự biết ai đã
rời — token sống tới khi có người chạy lệnh này.
```

- [ ] **Step 4: Chạy toàn bộ test**

Run: `npm test`
Expected: PASS cả 3 workspace, tổng số test > 694.

- [ ] **Step 5: Kiểm tra tại chỗ bằng Docker**

```bash
cp .env.example .env
sed -i '' 's/^CCRC_TOKEN=$/CCRC_TOKEN=thu-nghiem-tai-cho/' .env
docker compose up -d --build
curl -s localhost:8720/api/auth/config
```
Expected: `{"slackLogin":false}` — chưa cấu hình thì fail-closed.

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8720/auth/start
```
Expected: `503`.

```bash
curl -s -X POST localhost:8720/api/device/start -H 'content-type: application/json' -d '{}'
```
Expected: JSON có `deviceCode`, `userCode` dạng `XXXX-XXXX`, `ttl: 600`, `interval: 5`.

```bash
docker compose down
```

- [ ] **Step 6: Commit**

```bash
git add .env.example docker-compose.yml README.md
git commit -m "Document and wire the Slack login configuration

Both URLs must be set or the feature stays off, so a half-configured
hub falls back to token paste instead of redirecting somewhere it
cannot complete."
```

- [ ] **Step 7: Chốt lại trước khi merge**

Kiểm tra bằng tay, đánh dấu từng ý:

- [ ] PR token-slayer (Task 1–2) đã được merge và deploy — **hub không chạy được luồng Slack nếu chưa có nó**
- [ ] `npm test` xanh toàn bộ
- [ ] `git log --oneline` cho thấy 10 commit của Task 3–12
- [ ] Đọc lại spec §6b.4: đã ghi nhận việc đổi workspace Slack sẽ mất state

---

## Self-Review

**Spec coverage:**

| Mục spec | Task |
|---|---|
| §2.5 không cầm bearer | 1, 6 |
| §4.1 identity.js / device-code.js / oauth-state.js | 6, 5, 4 |
| §4.1 kho trong RAM | 4, 5 |
| §4.3 hai URL tách bạch | 7, 12 |
| §4.4 shape users.json + tương thích ngược | 3 |
| §4.5 deluser, khớp nhiều thì không xoá | 3, 11 |
| §5.1 luồng PWA + claimCode | 7, 9 |
| §5.2 device-code, bảng chữ, trần pending | 5, 8, 10 |
| §5.3 bảng route + `/link` | 7, 8, 9 |
| §6 mọi dòng bảng lỗi | 7, 8 |
| §6 trang lỗi tĩnh không tự redirect | 7 |
| §6 không ghi users.json khi lỗi | 7 |
| §7 4 file token-slayer | 1, 2 |
| §7.1 chống open redirect | 2 |
| §7.2 lý do không dùng lại exchange của IDE | 1 |
| §8.1 6 file test hub | 3, 4, 5, 6, 7, 8, 10, 11 |
| §8.2 test token-slayer | 1, 2 |
| §8.3 TDD tương thích ngược trước | 3 bước 2 |

Không có mục nào của spec thiếu task.

**Đã sửa khi tự rà:**
- Spec §6 ghi "đếm lần sai theo phiên duyệt", nhưng một `userCode` sai không trỏ tới phiên nào để đếm vào. Task 5 làm rõ: đếm theo **người duyệt** (họ đã xác thực nên bám được), và có test chứng minh khoá không lây sang người khác.
- Bản đầu để Task 8 commit với một test đỏ (`/link` chưa có `#link-card`) rồi Task 9 làm nó xanh. Đã bỏ: commit test đỏ là thứ review coi là lỗi, và không có lý do gì phải làm vậy. Task 8 kiểm `/link` trả đúng một trang HTML; Task 9 siết assertion đó lên thành `#link-card` khi thẻ đã tồn tại.
- Test happy-path của Task 8 từng phải `setTimeout(5100)` vì bị chặn nhịp poll. Đã bỏ: duyệt trước rồi poll lần đầu (lần đầu không bị chặn), tách 428 thành test riêng.
- Task 3 từng thêm một dòng `import` thứ hai từ cùng `users.js`. Đã gộp vào dòng import sẵn có.
- `index.js` **chưa import `crypto`** — đã ghi thành một bước riêng ở Task 7 bước 3.
