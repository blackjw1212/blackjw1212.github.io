---
title: "從 0 到 1：為何我選擇 HomeSpan 作為 HomeKit 開發的核心？"
categories: 技術實作
tags: HomeKit, HomeSpan, ESP32, 智慧家庭
last_modified_at: 2026-01-23
excerpt: "在追求智慧家庭穩定性的路上，嚴格遵循 HomeKit 規範就是提升勝率的唯一路徑。"
---

## 為什麼是 HomeSpan？

身為一個對穩定性有近乎強迫症的台灣開發者，我在嘗試過各種 ESP32 的 HomeKit 方案後，最終定錨在 **HomeSpan**。

在智慧家庭的領域，「能動」跟「穩定」是兩個完全不同的層次。許多開源方案雖然能快速上線，但往往在長時間運行後會出現連線逾期或響應緩慢的問題。對我來說，**「勝率」不在於功能的多寡，而是在於每一次打開「家庭」App 時，設備都能在 0.5 秒內做出回應。**

### 嚴格遵循規範的必要性

HomeSpan 最令我著迷的地方，在於它對 Apple HomeKit Accessory Protocol (HAP) 的嚴格實現。

1. **正向邏輯開發**：它強制你必須理解 Service 與 Characteristic 的關係，而不是胡亂套用模板。
2. **記憶體管理優化**：在 ESP32 有限的資源下，HomeSpan 表現得極度精簡且穩定。
3. **無痛迭代**：正如我一直堅持的原則——「迭代時不刪除原本功能」。HomeSpan 的類別化結構讓我可以輕鬆擴充新的感測器，而不影響原有的控制邏輯。

### 程式碼的藝術

在開發過程中，我習慣保持代碼的整潔與規範。以下是我常用的基本結構：

```cpp
// 嚴格遵循 HomeSpan 結構範例
struct My_LightFixture : Service::LightBulb { 
  SpanCharacteristic *power;                        
  
  My_LightFixture() : Service::LightBulb(){       
    power = new Characteristic::On();               
  } 

  boolean update(){                              
    // 在這裡實作台灣在地化的控制邏輯
    LOG1("燈光狀態變更中...");
    return(true);                               
  }
};
