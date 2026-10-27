# אקינטור

משחק אקינטור מעוצב לטלפון, מבוסס על [aki-api](https://github.com/jgoralcz/aki-api). בוחרים שפה, עונים על שאלות על הדמות, ואקינטור מנחש.

- `npm start`: הפעלה רגילה (http://localhost:3000)
- `npm run mock`: מצב בדיקה בלי אינטרנט, עם שאלות לדוגמה
- פרסום לטלפון: `node publisher/publish.mjs projects/akinator`

הערה: `server.js` טוען את `aki-api/dist/src/Akinator` ישירות, כי ה-`index.js` של הספרייה קורא קובץ תעודות שנוצר רק בסקריפט התקנה, והפרסום לטלפון מדלג על סקריפטי התקנה.
