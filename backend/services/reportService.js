const SchoolDatabaseManager = require('../utils/schoolDatabaseManager');
const ReportCalculations = require('./reportCalculations');
const { ObjectId } = require('mongodb');
const Result = require('../models/Result');

class ReportService {
  async getSchoolSummary(schoolId, schoolCode, filters = {}) {
    try {
      console.log('🔍 [getSchoolSummary] Starting summary for school:', schoolCode, 'with filters:', JSON.stringify(filters, null, 2));
      
      const { targetClass, targetSection, from, to } = filters;
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const academicYear = `${currentYear}-${currentYear + 1}`;
      
      // Set default date range to current month if not provided
      const startDate = from || new Date(currentYear, currentDate.getMonth(), 1);
      const endDate = to || new Date(currentYear, currentDate.getMonth() + 1, 0);
      
      // Convert schoolId to ObjectId (handle both string and ObjectId)
      let schoolObjectId;
      try {
        schoolObjectId = typeof schoolId === 'string' ? new ObjectId(schoolId) : schoolId;
      } catch (err) {
        console.error(' Invalid schoolId format:', schoolId);
        schoolObjectId = schoolId; // Use as-is if conversion fails
      }
      
      console.log(' [getSchoolSummary] SchoolId:', schoolId, 'ObjectId:', schoolObjectId);
      
      // Get database connection
      const connection = await SchoolDatabaseManager.getSchoolConnection(schoolCode);
      const db = connection.db;
      
      console.log(' [getSchoolSummary] Database name:', db.databaseName);
      
      // Build match query for results - more flexible to find any results
      const matchQuery = {
        $or: [
          { schoolId: schoolObjectId },
          { schoolId: schoolId.toString() },
          { schoolCode: { $regex: `^${schoolCode}$`, $options: 'i' } } // Case-insensitive schoolCode match
        ]
        // Don't filter by academicYear or status initially to see what data exists
      };
      
      // Add class filter if provided (match both 'class' and 'className' fields)
      if (targetClass && targetClass !== 'ALL') {
        matchQuery.$and = matchQuery.$and || [];
        matchQuery.$and.push({
          $or: [
            { class: targetClass.toString() },
            { className: targetClass.toString() }
          ]
        });
      }
      
      // Add section filter if provided (case-insensitive)
      if (targetSection && targetSection !== 'ALL') {
        matchQuery.$and = matchQuery.$and || [];
        // Create case-insensitive regex for section matching
        const sectionRegex = new RegExp(`^${targetSection.toString()}$`, 'i');
        matchQuery.$and.push({
          $or: [
            { section: sectionRegex },
            { sectionName: sectionRegex },
            { section: targetSection.toString() },
            { sectionName: targetSection.toString() }
          ]
        });
        console.log(' [getSchoolSummary] Section filter applied:', targetSection);
      }
      
      console.log(' [getSchoolSummary] Final match query:', JSON.stringify(matchQuery, null, 2));
      
      // Debug: First, check if we have any documents at all in school database
      const totalDocs = await db.collection('results').countDocuments({});
      console.log(` [getSchoolSummary] Total documents in school results collection: ${totalDocs}`);
      
      if (totalDocs === 0) {
        console.log(' [getSchoolSummary] The school results collection is empty');
        return {
          totalStudents: 0,
          totalMarks: 0,
          totalResults: 0,
          avgMarks: 0,
          avgAttendance: 0,
          classResults: [],
          attendanceData: []
        };
      }
      
      // Check with match query
      const resultCount = await db.collection('results').countDocuments(matchQuery);
      console.log(` [getSchoolSummary] Found ${resultCount} results matching query`);
      
      // Get sample document to debug
      const sampleDoc = await db.collection('results').findOne({});
      console.log(' [getSchoolSummary] Sample result document:', JSON.stringify(sampleDoc, null, 2));
      
      // Check what schoolId format is in the database
      if (sampleDoc && sampleDoc.schoolId) {
        console.log(' [getSchoolSummary] Sample schoolId type:', typeof sampleDoc.schoolId, 'Value:', sampleDoc.schoolId);
      }
      
      // Debug: Check section field values
      if (targetSection && targetSection !== 'ALL') {
        const sectionSample = await db.collection('results').findOne({
          $or: [
            { section: { $exists: true } },
            { sectionName: { $exists: true } }
          ]
        });
        console.log(' [getSchoolSummary] Sample section data:', {
          section: sectionSample?.section,
          sectionName: sectionSample?.sectionName,
          requestedSection: targetSection
        });
      }
      
      // Get class-wise results using school database
      const [classResults, attendanceData] = await Promise.all([
        // Get academic results from school database (subjects array structure)
        db.collection('results').aggregate([
          { 
            $match: { 
              ...matchQuery,
              subjects: { $exists: true, $ne: [] },
              className: { $exists: true, $ne: null, $ne: '' }  
            } 
          },
          {
            $unwind: '$subjects'
          },
          {
            $group: {
              _id: {
                class: '$className',
                section: '$section',
                userId: '$userId'
              },
              studentName: { $first: '$studentName' },
              avgPercentage: { $avg: '$subjects.percentage' }
            }
          },
          {
            $group: {
              _id: {
                class: '$_id.class',
                section: '$_id.section'
              },
              totalStudents: { $addToSet: '$_id.userId' },
              avgPercentage: { $avg: '$avgPercentage' },
              totalResults: { $sum: 1 }
            }
          },
          {
            $project: {
              _id: 0,
              class: '$_id.class',
              section: '$_id.section',
              totalStudents: { $size: '$totalStudents' },
              avgMarks: { $round: ['$avgPercentage', 2] },
              totalResults: 1
            }
          },
          { $sort: { class: 1, section: 1 } }
        ]).toArray(),
        
        // Get attendance data from school database (session-based structure)
        db.collection('attendances').aggregate([
          {
            $match: {
              schoolCode: schoolCode,
              documentType: 'session_attendance'
            }
          },
          // Add class/section filters if provided (case-insensitive)
          ...(targetClass && targetClass !== 'ALL' ? [{ $match: { class: new RegExp(`^${targetClass.toString()}$`, 'i') } }] : []),
          ...(targetSection && targetSection !== 'ALL' ? [{ $match: { section: new RegExp(`^${targetSection.toString()}$`, 'i') } }] : []),
          {
            $unwind: '$students'
          },
          {
            $group: {
              _id: {
                class: '$class',
                section: '$section',
                studentId: '$students.studentId'
              },
              totalSessions: { $sum: 1 },
              presentSessions: {
                $sum: {
                  $cond: [
                    { $eq: ['$students.status', 'present'] },
                    1,
                    0
                  ]
                }
              },
              halfDaySessions: {
                $sum: {
                  $cond: [
                    { $eq: ['$students.status', 'half_day'] },
                    0.5,
                    0
                  ]
                }
              }
            }
          },
          {
            $group: {
              _id: {
                class: '$_id.class',
                section: '$_id.section'
              },
              totalStudents: { $sum: 1 },
              avgAttendance: {
                $avg: {
                  $multiply: [
                    {
                      $divide: [
                        { $add: ['$presentSessions', '$halfDaySessions'] },
                        '$totalSessions'
                      ]
                    },
                    100
                  ]
                }
              }
            }
          },
          {
            $project: {
              _id: 0,
              class: '$_id.class',
              section: '$_id.section',
              totalStudents: 1,
              attendancePercentage: { $round: ['$avgAttendance', 2] }
            }
          },
          { $sort: { class: 1, section: 1 } }
        ]).toArray()
      ]);

      // Debug: Log raw data before calculations
      console.log(' [getSchoolSummary] Raw classResults:', JSON.stringify(classResults, null, 2));
      console.log(' [getSchoolSummary] Raw attendanceData:', JSON.stringify(attendanceData, null, 2));
      
      // Calculate overall summary
      let totalStudents = classResults.reduce((sum, item) => sum + (item.totalStudents || 0), 0);
      const totalMarks = classResults.reduce((sum, item) => sum + (item.avgMarks * item.totalResults), 0);
      const totalResults = classResults.reduce((sum, item) => sum + (item.totalResults || 0), 0);
      const avgMarks = totalResults > 0 ? totalMarks / totalResults : 0;
      
      // Calculate average attendance
      const totalAttendance = attendanceData.reduce((sum, item) => sum + (item.attendancePercentage || 0), 0);
      const avgAttendance = attendanceData.length > 0 ? totalAttendance / attendanceData.length : 0;
      
      // If no students from results, use attendance data for student count
      if (totalStudents === 0 && attendanceData.length > 0) {
        totalStudents = attendanceData.reduce((sum, item) => sum + (item.totalStudents || 0), 0);
        console.log(' [getSchoolSummary] Using attendance data for student count:', totalStudents);
      }
      
      // Debug: Log calculated values
      console.log(' [getSchoolSummary] Calculated values:', {
        totalStudents,
        totalMarks,
        totalResults,
        avgMarks: Math.round(avgMarks * 10) / 10,
        avgAttendance: Math.round(avgAttendance * 10) / 10,
        classResultsCount: classResults.length,
        attendanceDataCount: attendanceData.length
      });

      // Merge results and attendance data for class-wise display
      let classWiseResults = classResults;
      
      // If no results data, use attendance data to populate class-wise table
      if (classResults.length === 0 && attendanceData.length > 0) {
        classWiseResults = attendanceData.map(att => ({
          class: att.class,
          section: att.section,
          totalStudents: att.totalStudents,
          avgMarks: 0,
          avgAttendance: att.attendancePercentage,
          totalResults: 0
        }));
      } else if (classResults.length > 0) {
        // Merge attendance data into results
        classWiseResults = classResults.map(result => {
          let avgAttendance = 0;
          
          console.log(` [getSchoolSummary] Processing result for class: ${result.class}, section: ${result.section}`);
          
          // Match attendance by both class AND section for accurate section-wise data
          const classAttendance = attendanceData.filter(att => {
            const classMatches = att.class === result.class;
            const sectionMatches = att.section === result.section;
            console.log(`   Comparing attendance (${att.class}, ${att.section}) with result (${result.class}, ${result.section}): class=${classMatches}, section=${sectionMatches}`);
            return classMatches && sectionMatches;
          });
          
          console.log(`   Found ${classAttendance.length} attendance records for class ${result.class}`);
          
          if (classAttendance.length > 0) {
            const totalAttendance = classAttendance.reduce((sum, att) => sum + (att.attendancePercentage || 0), 0);
            avgAttendance = totalAttendance / classAttendance.length;
            console.log(`   Calculated avgAttendance: ${avgAttendance}`);
          } else {
            console.log(`   No attendance data found for class ${result.class}`);
          }
          
          return {
            ...result,
            avgAttendance: Math.round(avgAttendance * 10) / 10
          };
        });
      }

      return {
        classWiseResults,
        summary: {
          totalClasses: classWiseResults.length > 0 
            ? new Set(classWiseResults.map(r => r.class)).size 
            : 0,
          totalStudents,
          avgMarks: Math.round(avgMarks * 10) / 10,
          avgAttendance: Math.round(avgAttendance * 10) / 10
        }
      };
      
    } catch (error) {
      console.error('❌ [getSchoolSummary] Error:', {
        message: error.message,
        stack: error.stack,
        schoolId,
        filters
      });
      
      // Return a more detailed error response
      const errorResponse = {
        success: false,
        error: 'Failed to generate school summary',
        details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        classWiseResults: [],
        summary: {
          totalClasses: 0,
          totalStudents: 0,
          avgMarks: 0
        }
      };
      
      return errorResponse;
    }
  }

  // Add the exportToCSV method
  async exportToCSV(schoolId, schoolCode, exportType, filters = {}) {
    try {
      const connection = await SchoolDatabaseManager.getSchoolConnection(schoolCode);
      const db = connection.db;

      const { class: targetClass, section: targetSection, from, to } = filters;
      let data = [];
      let headers = [];

      switch (exportType) {
        case 'dues':
          const duesQuery = { 
            schoolId: new ObjectId(schoolId),
            totalPending: { $gt: 0 }
          };
          
          if (targetClass && targetClass !== 'ALL') duesQuery.studentClass = targetClass;
          if (targetSection && targetSection !== 'ALL') duesQuery.studentSection = targetSection;
          if (filters.status && filters.status !== 'ALL') {
            // Status should be lowercase to match database enum
            duesQuery.status = filters.status.toLowerCase();
          }
          if (filters.search) {
            const searchRegex = new RegExp(filters.search, 'i');
            duesQuery.$or = [
              { studentName: searchRegex },
              { rollNumber: searchRegex }
            ];
          }

          const dues = await db.collection('studentfeerecords').aggregate([
            { $match: duesQuery },
            { $unwind: '$installments' },
            {
              $project: {
                _id: 0,
                'Student Name': '$studentName',
                'Class': '$studentClass',
                'Section': '$studentSection',
                'Fee Structure': '$feeStructureName',
                'Installment': '$installments.name',
                'Amount': '$installments.amount',
                'Paid Amount': '$installments.paidAmount',
                'Balance': { $subtract: ['$installments.amount', '$installments.paidAmount'] },
                'Status': {
                  $let: {
                    vars: {
                      isPaid: { $eq: ['$installments.status', 'PAID'] },
                      hasPartial: { $gt: ['$installments.paidAmount', 0] },
                      isOverdue: { $lt: ['$installments.dueDate', new Date()] }
                    },
                    in: {
                      $switch: {
                        branches: [
                          { case: '$$isPaid', then: 'Paid' },
                          { case: '$$hasPartial', then: 'Partial' },
                          { case: '$$isOverdue', then: 'Overdue' }
                        ],
                        default: 'Pending'
                      }
                    }
                  }
                }
              }
            },
            { $sort: { 'Class': 1, 'Section': 1, 'Student Name': 1 } }
          ]).toArray();

          if (dues.length > 0) {
            headers = Object.keys(dues[0]);
            data = dues.map(record => Object.values(record));
          } else {
            headers = ['Message'];
            data = [['No dues records found matching the criteria']];
          }
          break;

        // Add other export types (students, attendance, results) as needed
        default:
          headers = ['Message'];
          data = [['Export type not supported']];
      }

      // Convert to CSV format
      const csvContent = [
        headers.join(','),
        ...data.map(row => row.map(cell => `"${String(cell || '').replace(/"/g, '""')}"`).join(','))
      ].join('\n');

      return csvContent;
    } catch (error) {
      console.error('Error exporting data:', error);
      throw error;
    }
  } // Added closing brace here

  // Get students by class and section with their marks and attendance
  async getStudentsByClassSection(schoolId, schoolCode, className, section, academicYear) {
    try {
      console.log('🔍 [getStudentsByClassSection] Fetching students for:', { schoolCode, className, section, academicYear });
      
      const connection = await SchoolDatabaseManager.getSchoolConnection(schoolCode);
      const db = connection.db;
      
      // STEP 1: Fetch ALL students from students collection first
      // Use the SAME matching logic as the frontend to ensure consistency
      const studentsMatchQuery = {
        role: 'student',
        isActive: { $ne: false }
      };

      // Add class filter - PRIORITY: academicInfo.class > studentDetails.currentClass > class
      if (className) {
        const classRegex = { $regex: `^${className.toString()}$`, $options: 'i' };
        studentsMatchQuery.$or = [
          { 'academicInfo.class': classRegex },
          { 'studentDetails.academic.currentClass': classRegex },
          { 'studentDetails.currentClass': classRegex },
          { 'studentDetails.class': classRegex },
          { class: classRegex }
        ];
      }

      // Add section filter - PRIORITY: academicInfo.section > studentDetails.currentSection > section
      if (section && section !== 'ALL' && section !== 'All' && section !== 'All Sections') {
        const sectionRegex = { $regex: `^${section.toString()}$`, $options: 'i' };
        const sectionFilter = {
          $or: [
            { 'academicInfo.section': sectionRegex },
            { 'studentDetails.academic.currentSection': sectionRegex },
            { 'studentDetails.currentSection': sectionRegex },
            { 'studentDetails.section': sectionRegex },
            { section: sectionRegex }
          ]
        };
        
        if (studentsMatchQuery.$or) {
          // Combine both class and section filters with $and
          studentsMatchQuery.$and = [
            { $or: studentsMatchQuery.$or },
            sectionFilter
          ];
          delete studentsMatchQuery.$or;
        } else {
          // No class filter, just add section filter
          Object.assign(studentsMatchQuery, sectionFilter);
        }
      }

      // Add academic year filter if provided
      if (academicYear) {
        const academicYearFilter = {
          $or: [
            { 'studentDetails.academicYear': academicYear },
            { 'studentDetails.academic.academicYear': academicYear },
            { 'academicYear': academicYear },
            { 'academicInfo.academicYear': academicYear }
          ]
        };
        
        if (studentsMatchQuery.$and) {
          studentsMatchQuery.$and.push(academicYearFilter);
        } else {
          studentsMatchQuery.$and = [academicYearFilter];
        }
      }

      console.log('📋 Students collection query:', JSON.stringify(studentsMatchQuery, null, 2));
      
      const allStudents = await db.collection('students').find(studentsMatchQuery).toArray();
      console.log(`✅ Found ${allStudents.length} students in students collection matching class/section/academic year filters`);
      
      if (allStudents.length === 0) {
        console.log('⚠️ No students found in students collection');
        return { success: true, students: [] };
      }

      // Get student IDs for lookup
      const studentIds = allStudents.map(s => s.userId);
      console.log(`📝 Student IDs to lookup:`, studentIds.slice(0, 5), `... (${studentIds.length} total)`);

      // STEP 2: Fetch results for these students
      const resultsMatchQuery = {
        userId: { $in: studentIds },
        subjects: { $exists: true, $ne: [] }
      };

      // Add academic year filter to results
      if (academicYear) {
        resultsMatchQuery.academicYear = academicYear;
      }

      console.log('📊 Results query:', JSON.stringify(resultsMatchQuery, null, 2));
      
      const studentResults = await db.collection('results').aggregate([
        { $match: resultsMatchQuery },
        { $unwind: '$subjects' },
        {
          $group: {
            _id: '$userId',
            totalObtained: { $sum: '$subjects.obtainedMarks' },
            totalMarks: { $sum: '$subjects.totalMarks' },
            avgPercentage: { $avg: '$subjects.percentage' }
          }
        },
        {
          $project: {
            _id: 0,
            studentId: '$_id',
            avgMarks: {
              $round: [
                {
                  $cond: [
                    { $gt: ['$totalMarks', 0] },
                    { $multiply: [{ $divide: ['$totalObtained', '$totalMarks'] }, 100] },
                    '$avgPercentage'
                  ]
                },
                2
              ]
            }
          }
        }
      ]).toArray();
      
      console.log(`✅ Found results for ${studentResults.length} students`);
      if (studentResults.length > 0) {
        console.log(`📊 Sample result calculation:`, studentResults[0]);
      }

      // STEP 3: Fetch attendance for these students
      const attendanceMatchQuery = {
        schoolCode: schoolCode,
        documentType: 'session_attendance',
        'students.studentId': { $in: studentIds }
      };

      if (academicYear) {
        attendanceMatchQuery.academicYear = academicYear;
      }

      console.log('👥 Attendance query:', JSON.stringify(attendanceMatchQuery, null, 2));

      const studentAttendance = await db.collection('attendances').aggregate([
        { $match: attendanceMatchQuery },
        { $unwind: '$students' },
        { $match: { 'students.studentId': { $in: studentIds } } },
        {
          $group: {
            _id: '$students.studentId',
            totalSessions: { $sum: 1 },
            presentSessions: {
              $sum: {
                $cond: [
                  { $eq: ['$students.status', 'present'] },
                  1,
                  0
                ]
              }
            },
            halfDaySessions: {
              $sum: {
                $cond: [
                  { $eq: ['$students.status', 'half_day'] },
                  0.5,
                  0
                ]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            studentId: '$_id',
            attendancePercentage: {
              $round: [
                {
                  $multiply: [
                    {
                      $divide: [
                        { $add: ['$presentSessions', '$halfDaySessions'] },
                        '$totalSessions'
                      ]
                    },
                    100
                  ]
                },
                2
              ]
            }
          }
        }
      ]).toArray();

      console.log(`✅ Found attendance for ${studentAttendance.length} students`);
      console.log(`📊 [DEBUG] Total students returned: ${allStudents.length}`);
      
      // STEP 4: Create lookup maps
      const resultsMap = new Map();
      studentResults.forEach(result => {
        resultsMap.set(result.studentId, result.avgMarks);
      });

      const attendanceMap = new Map();
      studentAttendance.forEach(att => {
        attendanceMap.set(att.studentId, att.attendancePercentage);
      });

      // STEP 5: Extract student names consistently - match frontend logic
      const studentsArray = [];
      allStudents.forEach(student => {
        // Extract name using same priority as elsewhere in the codebase
        let studentName = 'Unknown';
        
        if (student.name?.displayName) {
          studentName = student.name.displayName;
        } else if (student.name?.firstName && student.name?.lastName) {
          studentName = `${student.name.firstName} ${student.name.lastName}`;
        } else if (student.name?.firstName) {
          studentName = student.name.firstName;
        } else if (student.name?.lastName) {
          studentName = student.name.lastName;
        } else if (typeof student.name === 'string') {
          studentName = student.name;
        }
        
        // Debug: Log first few students' extracted details
        if (studentsArray.length < 5) {
          console.log(`📝 Student: ${studentName} (ID: ${student.userId}), Class: ${className}, Section: ${section}`);
        }
        
        studentsArray.push({
          studentId: student.userId,
          studentName: studentName,
          avgMarks: resultsMap.get(student.userId) || 0,
          avgAttendance: attendanceMap.get(student.userId) || 0
        });
      });
      
      const students = studentsArray;

      console.log(`✅ Returning ${students.length} students with enriched data`);
          
      return {
        success: true,
        students: students.sort((a, b) => a.studentName.localeCompare(b.studentName))
      };
      
    } catch (error) {
      console.error('❌ [getStudentsByClassSection] Error:', error);
      throw error;
    }
  }
}

module.exports = new ReportService();