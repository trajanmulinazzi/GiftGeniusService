export class User {
  constructor(age, gender, relationship, hobbies, budget_min, budget_max) {
    this.profile = {
      age: age,
      gender: gender,
      relationship: relationship,
      hobbies: hobbies,
      budget_min: budget_min,
      budget_max: budget_max,
    };
    this.likedItems = [];
    this.dislikedItems = [];
  }

  addLikedItem(item) {
    this.likedItems.push(item);
  }

  addDislikedItem(item) {
    this.dislikedItems.push(item);
  }

  getProfile() {
    return this.profile;
  }

  getLikedItems() {
    return this.likedItems;
  }

  getDislikedItems() {
    return this.dislikedItems;
  }
}
