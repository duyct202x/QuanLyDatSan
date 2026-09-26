/**
 * Google Apps Script Backend - SMASH PRO Badminton Management System
 * Hỗ trợ lưu trữ CSDL riêng biệt cho 2 môi trường:
 *  1. Sheet "CSDL_VanHanh_Prod" (Mặc định cho vận hành thực tế)
 *  2. Sheet "CSDL_KiemThu_Test" (Dành cho kiểm thử mẫu)
 * 
 * Hướng dẫn triển khai:
 * 1. Mở Google Sheet trên Google Drive của bạn.
 * 2. Vào Tiện ích mở rộng -> Apps Script.
 * 3. Dán toàn bộ mã nguồn này vào tệp Code.gs.
 * 4. Nhấn "Triển khai" -> "Tùy chọn triển khai mới" -> Chọn loại "Ứng dụng web".
 * 5. Chọn quyền truy cập: "Bất kỳ ai" (Anyone).
 * 6. Sao chép URL triển khai và sử dụng trong ứng dụng.
 */

// Tên các Sheet phân tách
var SHEET_PROD = "CSDL_VanHanh_Prod";
var SHEET_TEST = "CSDL_KiemThu_Test";

// Hàm xử lý HTTP GET: Đọc dữ liệu từ Google Sheet
function doGet(e) {
  try {
    var sheetParam = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : "Prod";
    var targetSheetName = (sheetParam.toLowerCase().indexOf("test") !== -1) ? SHEET_TEST : SHEET_PROD;
    
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(targetSheetName);
    
    // Nếu sheet chưa tồn tại, tự động tạo mới
    if (!sheet) {
      sheet = ss.insertSheet(targetSheetName);
      sheet.getRange(1, 1).setValue("DATA_JSON");
      sheet.getRange(1, 2).setValue("LAST_UPDATED");
    }
    
    var dataValue = sheet.getRange(2, 1).getValue();
    
    if (!dataValue || dataValue.toString().trim() === "") {
      return ContentService.createTextOutput(JSON.stringify({
        status: "empty",
        sheetName: targetSheetName,
        message: "Chưa có dữ liệu trong sheet này."
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(dataValue.toString())
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Hàm xử lý HTTP POST: Ghi dữ liệu vào Google Sheet
function doPost(e) {
  try {
    var rawData = e.postData.contents;
    if (!rawData) {
      return ContentService.createTextOutput(JSON.stringify({
        status: "error",
        message: "Dữ liệu gửi lên trống!"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    var parsed = {};
    try {
      parsed = JSON.parse(rawData);
    } catch(err) {}
    
    var sheetParam = (e && e.parameter && e.parameter.sheet) ? e.parameter.sheet : (parsed.sheetName || "Prod");
    var targetSheetName = (sheetParam.toLowerCase().indexOf("test") !== -1) ? SHEET_TEST : SHEET_PROD;
    
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(targetSheetName);
    
    if (!sheet) {
      sheet = ss.insertSheet(targetSheetName);
      sheet.getRange(1, 1).setValue("DATA_JSON");
      sheet.getRange(1, 2).setValue("LAST_UPDATED");
      sheet.getRange(1, 1, 1, 2).setFontWeight("bold").setBackground("#4f46e5").setFontColor("#ffffff");
    }
    
    // Ghi dữ liệu JSON vào ô A2 và thời gian vào ô B2
    var nowStr = Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss");
    sheet.getRange(2, 1).setValue(rawData);
    sheet.getRange(2, 2).setValue(nowStr);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      sheetName: targetSheetName,
      lastUpdated: nowStr,
      message: "Đã lưu dữ liệu thành công vào sheet " + targetSheetName + "!"
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
