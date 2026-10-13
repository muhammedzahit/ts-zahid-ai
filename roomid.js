const uuid = "3900d470-ada9-11f1-a68e-0de9856027da"; // linkteki space= değeri
const roomId = Buffer.from(`ciscospark://us/ROOM/${uuid}`)
  .toString("base64")
  .replace(/=+$/, ""); // sondaki padding'i at
console.log(roomId);