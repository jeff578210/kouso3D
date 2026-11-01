這是一款結合 AI 視覺追蹤與語音辨識的「健口操互動遊戲」。

傳統的口腔運動（健口操）往往需要重複單調的動作，為了解決使用者缺乏動力的痛點，本專案將人體的嘴部動作與聲音直接轉化為「遊戲控制器」。透過前端網頁技術與輕量化 AI 模型的無縫整合，打造出一款低延遲、免安裝，且寓教於樂的沉浸式互動體驗。

🛠️ 核心技術棧 (Built With)
影像辨識 (Computer Vision): MediaPipe Face Mesh (負責高精準度、低延遲的臉部與舌頭節點追蹤)

語音處理 (Audio Processing): Web Speech API (負責即時擷取並分析語音與發音特徵)

互動渲染 (Rendering): Three.js (處理遊戲畫面的動態視覺化呈現)

前端開發 (Frontend): HTML5, CSS3, JavaScript / Python (用於底層邏輯實作與系統整合)

✨ 關鍵功能 (Key Features)
即時臉部網格追蹤 (Real-time Face Tracking): 透過攝影機精準捕捉嘴部開合座標與舌頭動態，完全取代傳統的鍵盤與滑鼠操作。

發音特徵觸發 (Voice-Triggered Events): 系統能即時分析使用者的特定發音特徵，並將其轉化為觸發遊戲進程的關鍵指令。

低延遲流暢體驗 (Low-Latency Interaction): 針對影像與聲音的雙重資料流進行效能優化，確保在網頁端執行 AI 辨識時，仍能維持遊戲的高幀率 (FPS) 與即時回饋感。

🌲 3D 場景素材 (Credits)
KayKit Forest Nature Pack by Kay Lousberg (www.kaylousberg.com),CC0 授權,授權檔在 assets3d/KayKit-Forest-License.txt。
