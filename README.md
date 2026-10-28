# 恶魔岛·雾夜越狱 · ALCATRAZ: FOGBREAK

**▶ 在线游玩 / Play: https://haidongnie.github.io/alcatraz-fogbreak/**

1962 年 6 月 11 日夜，旧金山湾。1–4 人在浏览器里合作，从按真实数据还原的恶魔岛联邦监狱越狱：
放好假人头、撬开通风口、钻进管道走廊、偷回钻头、钻开屋顶通风口、顺着面包房烟道滑下、翻过铁丝网，
在探照灯扫过之前把木筏推进浓雾。

A 1–4 player browser co-op stealth game on a data-driven reconstruction of Alcatraz Island on the
night of 11 June 1962. The story and characters are original fiction inspired by the real escape.

## 怎么和朋友一起玩 / Multiplayer

1. 打开游戏 → 输入名字 → **联机合作 / Play online**。
2. 在大厅点 **复制邀请链接**，发给朋友（链接里带有房间号 `#r=…`）。朋友打开链接即可加入。
3. 房主点 **开始越狱**。最多 4 人；单人也能通关（装备包数量会随人数调整）。

Open the game, pick **Play online**, copy the invite link from the lobby and send it to friends
(up to 4). The host starts the night. Solo works too.

## 操作 / Controls

| | 键盘鼠标 Desktop | 手机 Mobile |
|---|---|---|
| 移动 Move | WASD | 左摇杆 left stick |
| 视角 Look | 鼠标（点击画面锁定）mouse (click to lock) | 右侧拖动 drag right side |
| 跑 / 蹲 Run / Crouch | Shift / C | 按钮 buttons |
| 互动（按住）Interact (hold) | E | ✋ |
| 放下 / 扔 Drop / Throw | G / F | ⬇ |
| 演奏手风琴（牢房内，掩盖噪音）Concertina | Q | ♪ |
| 地图 / 菜单 Map / Menu | M / Esc | |
| 木筏 Raft | W/S 划桨, A/D 转向 | 摇杆 |

## 真实还原 / What is real

- **岛屿地形与海岸线**：AWS Terrain Tiles（USGS 3DEP 等）高程 + OpenStreetMap 海岸线，`scripts/data/build-island.mjs`。
- **建筑位置与轮廓**：OpenStreetMap 建筑足迹（主监狱、餐厅、行政楼、灯塔、水塔、发电厂与烟囱、工业楼、64 号楼、典狱长住宅……），按 1962 年状态复原（典狱长住宅与军官俱乐部当时完好）。
- **监舍内部**：依据监狱局一层平面图测得的尺寸——A/B/C/D 四个监区、每层 28 间、牢房 1.52×2.74×2.13 m、三层走廊、百老汇大道 / 密歇根大道 / 时代广场、B 区中间的管道走廊、两侧枪廊、图书馆、D 区禁闭室。
- **越狱路线**：B-138/140/150/152 号牢房 → 通风口 → 管道走廊 → B 区顶部工作间 → 屋顶通风机 → 面包房烟道 → 两道 3.7 m 铁丝网 → 发电厂旁的东北岸（探照灯盲区）。
- 详细资料与出处见 [docs/RESEARCH.md](docs/RESEARCH.md)；设计见 [docs/DESIGN.md](docs/DESIGN.md)；代码结构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 技术 / Tech

- **three.js r186** WebGPURenderer（自动回退 WebGL2），AgX 色调映射、GTAO、Bloom、TRAA，Rapier 物理角色控制器。
- **Playroom Kit** 联机：房主权威（守卫 AI、规则、木筏在房主端模拟），客户端通过 RPC 请求动作；房主掉线自动迁移。
- **Meshy AI**（`meshy-t2.5` smart-topology）生成 37 个模型：4 名囚犯 + 狱警（自动绑定骨骼 + 动画库动作）、牢房家具、越狱道具、灯塔、水塔、岗楼、巡逻艇等；经 meshopt + WebP 压缩到总计约 12 MB。

### 本地开发 / Development

```bash
npm install
npm run dev
```

可选：在 https://dev.joinplayroom.com 创建项目，把 `gameId` 写入 `.env` 的 `VITE_PLAYROOM_GAME_ID=`
（GitHub Actions 读取仓库变量 `PLAYROOM_GAME_ID`）。不设置也能玩，Playroom 只会在控制台给出警告。

### 重新生成模型 / Regenerating the Meshy assets

```bash
echo "MESHY_API_KEY=msy_..." > .env      # git-ignored, never committed
npm run meshy:generate                    # text-to-3D preview → refine (PBR) → rig → animations
npm run meshy:optimize                    # → public/models/*.glb + manifest.json
```

Prompts and animation ids live in `scripts/meshy/assets.json`; progress/task ids in
`scripts/meshy/state.json` (re-runs never re-create a task).

## 致谢与许可 / Credits & license

- Code: MIT.
- Map data © OpenStreetMap contributors, ODbL. Elevation: AWS Open Data Terrain Tiles.
- 3D models generated with Meshy AI for this project.
- Multiplayer by Playroom Kit. Rendering by three.js, physics by Rapier.
- 本作为虚构故事，人物均为原创，灵感来自 1962 年真实事件。This is a work of fiction inspired by real events.
