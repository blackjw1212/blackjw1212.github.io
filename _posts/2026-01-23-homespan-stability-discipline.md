---
title: "寫給未來的自己：為什麼 HomeKit 專案一定要先顧穩定性"
categories: 技術實作
tags: HomeKit, HomeSpan, ESP32, 穩定性, 架構設計
last_modified_at: 2026-01-23
excerpt: "功能可以慢慢加，但一旦穩定性崩掉，HomeKit 專案幾乎沒有回頭路。"
---
這些問題，其實我以前也都問過

「為什麼 App 有時候不更新？」
「為什麼重開機後狀態會亂跳？」
「只是加一個感測器，為什麼整個系統變不穩？」

老實說，這些問題我幾乎都踩過。直到某一天我才意識到，問題不在 ESP32、不在 Wi-Fi，而是在開發當下沒有把 HomeKit 當成一個『嚴格系統』來對待。

HomeKit 不喜歡模糊的責任分界

在 HomeKit 的世界裡，每一個 Service、每一個 Characteristic，都有非常明確的角色定位。HomeSpan 做了一件很重要的事：它沒有幫你「偷吃步」。

如果你試圖把顯示邏輯、控制邏輯、感測邏輯混在一起，短期內或許能動，但只要設備數量一多、運行時間一拉長，問題一定會浮現。

這也是為什麼我後來在所有專案中，都刻意讓結構「看起來很笨」，但實際上卻非常穩定。

穩定性的關鍵：不讓 update() 做超出本分的事

下面是一個我實務中長期使用的寫法，重點只有一個：update 只處理 HomeKit 的狀態變化，不做額外判斷。

struct My_Fan : Service::Fan {
  SpanCharacteristic *power;

  My_Fan() : Service::Fan() {
    power = new Characteristic::On();
  }

  boolean update() {
    bool newState = power->getNewVal();
    // 僅轉換狀態，不讀感測器、不存設定
    setFanHardware(newState);
    return true;
  }
};


這樣做的好處是，不論 Home App、Siri、或自動化怎麼觸發，行為都完全一致，不會出現「偶發正常」的狀況。

迭代時，穩定性永遠優先於新功能

我現在幾乎不會在「功能還沒穩定」的情況下繼續加東西。因為一旦結構歪掉，後面只會用更多 hack 去補前面的 hack。

這也是我始終堅持的原則之一：
迭代可以慢，但絕對不能破壞原本已經穩定的行為。

結語：HomeSpan 教會我的，不只是怎麼寫程式

對我來說，HomeSpan 最珍貴的價值，不在於它讓 HomeKit 變簡單，而是在於它不斷提醒我一件事：

穩定性不是最佳化選項，而是設計前提。

當你願意尊重規範、尊重結構，其實很多你以為的「怪問題」，根本就不會出現。
